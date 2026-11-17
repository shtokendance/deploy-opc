import fs from 'fs/promises'
import path from 'path'
import type { Mount } from '../../models/DockerService'

export type ApplicationVolumeBackend = 'local-directory' | 'aliyun-oss-volume'

function canonicalPath(value: string) {
    return (
        /^\/(?:[\w.-]+\/)*[\w.-]+$/.test(value) &&
        !value.split('/').some((part) => part === '.' || part === '..')
    )
}

// Roots are explicitly exposed by the Swarm operator as writable binds at
// identical host and container paths. Never operate on the container root.
export async function prepareApplicationVolumePath(
    root: string,
    backend: ApplicationVolumeBackend,
    directory: string,
    create: boolean,
    serviceMounts: Mount[]
) {
    const allowed = (process.env.OPC_APP_VOLUME_ROOTS || '')
        .split(',')
        .find(
            (entry) =>
                canonicalPath(entry) &&
                serviceMounts.some(
                    (mount) =>
                        mount.Type === 'bind' &&
                        mount.Source === entry &&
                        mount.Target === entry &&
                        !mount.ReadOnly
                ) &&
                (root === entry || root.startsWith(entry + '/'))
        )
    if (
        !allowed ||
        !canonicalPath(root) ||
        (await fs.realpath(root)) !== root
    ) {
        throw new Error('Storage root is outside the configured Deploy mounts')
    }
    const mountInfo = await fs.readFile('/proc/self/mountinfo', 'utf8')
    const mounts = mountInfo
        .trim()
        .split('\n')
        .map((line) => {
            const [left, right] = line.split(' - ')
            const fields = left.split(' ')
            return {
                target: fields[4],
                writable: fields[5].split(',').includes('rw'),
                type: right.split(' ')[0],
            }
        })
    const filesystem = mounts
        .filter(
            ({ target }) => root === target || root.startsWith(target + '/')
        )
        .sort((a, b) => b.target.length - a.target.length)[0]
    if (
        !mounts.some(({ target }) => target === allowed) ||
        !filesystem?.writable
    ) {
        throw new Error('Storage root must be exposed as a writable host mount')
    }
    const isOSS = /^fuse\.ossfs2?$/.test(filesystem.type)
    if (
        backend === 'aliyun-oss-volume'
            ? !isOSS
            : filesystem.type.startsWith('fuse')
    ) {
        throw new Error(
            'Storage root filesystem does not match the selected backend'
        )
    }

    const rootStat = await fs.stat(root)
    if (!rootStat.isDirectory())
        throw new Error('Storage root must be a directory')
    await fs.access(root, fs.constants.W_OK | fs.constants.X_OK)
    if (!directory) return
    if (
        !/^[a-z0-9][a-z0-9-]{0,62}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/[a-z0-9][a-z0-9-]{0,79}$/.test(
            directory
        )
    ) {
        throw new Error('Invalid application volume directory')
    }

    let target = root
    const parts = directory.split('/')
    for (const [index, part] of parts.entries()) {
        target = path.posix.join(target, part)
        const leaf = index === parts.length - 1
        let created = false
        if (create) {
            try {
                await fs.mkdir(target, { mode: leaf ? 0o777 : 0o755 })
                created = true
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
            }
        }
        const stat = await fs.lstat(target)
        if (!stat.isDirectory() || stat.dev !== rootStat.dev) {
            throw new Error(
                'Application volume must be a directory on the configured filesystem'
            )
        }
        // Containers may use non-root UIDs. Only make a newly allocated leaf
        // writable. Ownership and modes on OSS are controlled by ossfs.
        if (created && leaf && !isOSS) await fs.chmod(target, 0o777)
    }
}

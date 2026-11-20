import fs from 'fs/promises'
import path from 'path'
import type { Mount } from '../../models/DockerService'

export type ApplicationVolumeBackend = 'local-directory' | 'aliyun-oss-volume'

export interface ApplicationVolumeRootInfo {
    root: string
    node_id: string
    backend: ApplicationVolumeBackend | ''
    filesystem_type: string
    writable: boolean
    available: boolean
    total_bytes?: number
    used_bytes?: number
    free_bytes?: number
    usage_ratio?: number
    error?: string
}

async function readRootDiskUsage(root: string): Promise<{
    total_bytes?: number
    used_bytes?: number
    free_bytes?: number
    usage_ratio?: number
}> {
    try {
        const stats = await fs.statfs(root)
        const bsize = Number(stats.bsize)
        const total = Number(stats.blocks) * bsize
        const free = Number(stats.bavail) * bsize
        const used = total >= free ? total - free : 0
        if (total > 0) {
            return {
                total_bytes: total,
                used_bytes: used,
                free_bytes: free,
                usage_ratio: Math.round((used * 1000) / total) / 10,
            }
        }
    } catch {
        // Ignore statfs errors on filesystems that do not report capacity.
    }
    return {}
}

interface MountInfoEntry {
    target: string
    writable: boolean
    type: string
}

function canonicalPath(value: string) {
    return (
        /^\/(?:[\w.-]+\/)*[\w.-]+$/.test(value) &&
        !value.split('/').some((part) => part === '.' || part === '..')
    )
}

function parseConfiguredRoots(rawRoots?: string): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const part of (
        rawRoots ??
        process.env.OPC_APP_VOLUME_ROOTS ??
        ''
    ).split(',')) {
        const trimmed = part.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        result.push(trimmed)
    }
    return result
}

function parseMountInfo(mountInfo: string): MountInfoEntry[] {
    return mountInfo
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [left, right] = line.split(' - ')
            const fields = left.split(' ')
            return {
                target: fields[4] || '',
                writable: (fields[5] || '').split(',').includes('rw'),
                type: (right || '').split(' ')[0] || '',
            }
        })
}

async function resolveVerifiedRoot(
    root: string,
    serviceMounts: Mount[],
    mountEntries: MountInfoEntry[],
    configuredRoots: string[]
) {
    const allowed = configuredRoots.find(
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
    const filesystem = mountEntries
        .filter(
            ({ target }) => root === target || root.startsWith(target + '/')
        )
        .sort((a, b) => b.target.length - a.target.length)[0]
    if (
        !mountEntries.some(({ target }) => target === allowed) ||
        !filesystem?.writable
    ) {
        throw new Error('Storage root must be exposed as a writable host mount')
    }
    const isOSS = /^fuse\.ossfs2?$/.test(filesystem.type)
    const rootStat = await fs.stat(root)
    if (!rootStat.isDirectory())
        throw new Error('Storage root must be a directory')
    await fs.access(root, fs.constants.W_OK | fs.constants.X_OK)
    return { filesystem, isOSS, rootStat }
}

export async function listApplicationVolumeRoots(
    nodeId: string,
    serviceMounts: Mount[],
    options?: {
        configuredRoots?: string
        mountInfoText?: string
    }
): Promise<ApplicationVolumeRootInfo[]> {
    const configuredRoots = parseConfiguredRoots(options?.configuredRoots)
    if (configuredRoots.length === 0) return []

    let mountEntries: MountInfoEntry[] = []
    let mountInfoError = ''
    try {
        const text =
            options?.mountInfoText ??
            (await fs.readFile('/proc/self/mountinfo', 'utf8'))
        mountEntries = parseMountInfo(text)
    } catch (err) {
        mountInfoError = err instanceof Error ? err.message : String(err)
    }

    const items: ApplicationVolumeRootInfo[] = []
    for (const root of configuredRoots) {
        if (mountInfoError) {
            items.push({
                root,
                node_id: nodeId,
                backend: '',
                filesystem_type: '',
                writable: false,
                available: false,
                error: mountInfoError,
            })
            continue
        }
        try {
            const { filesystem, isOSS } = await resolveVerifiedRoot(
                root,
                serviceMounts,
                mountEntries,
                configuredRoots
            )
            const unsupportedFuse = !isOSS && filesystem.type.startsWith('fuse')
            const backend: ApplicationVolumeBackend | '' = isOSS
                ? 'aliyun-oss-volume'
                : unsupportedFuse
                  ? ''
                  : 'local-directory'
            const diskUsage =
                backend !== '' ? await readRootDiskUsage(root) : {}
            items.push({
                root,
                node_id: nodeId,
                backend,
                filesystem_type: filesystem.type,
                writable: filesystem.writable,
                available: backend !== '',
                ...diskUsage,
                ...(backend === ''
                    ? {
                          error: 'Storage root filesystem does not match a supported backend',
                      }
                    : {}),
            })
        } catch (err) {
            items.push({
                root,
                node_id: nodeId,
                backend: '',
                filesystem_type: '',
                writable: false,
                available: false,
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }
    return items
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
    const configuredRoots = parseConfiguredRoots()
    const mountEntries = parseMountInfo(
        await fs.readFile('/proc/self/mountinfo', 'utf8')
    )
    const { filesystem, isOSS, rootStat } = await resolveVerifiedRoot(
        root,
        serviceMounts,
        mountEntries,
        configuredRoots
    )
    if (
        backend === 'aliyun-oss-volume'
            ? !isOSS
            : filesystem.type.startsWith('fuse')
    ) {
        throw new Error(
            'Storage root filesystem does not match the selected backend'
        )
    }

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

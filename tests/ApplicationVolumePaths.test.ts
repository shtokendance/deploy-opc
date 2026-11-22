import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type { Mount } from '../src/models/DockerService'
import {
    listApplicationVolumeRoots,
    removeLocalApplicationVolumeDirectory,
} from '../src/user/system/ApplicationVolumePaths'

describe('ApplicationVolumePaths.listApplicationVolumeRoots', () => {
    it('discovers configured writable local-directory and aliyun-oss-volume roots and reports unavailable roots', async () => {
        const base = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'opc-volume-roots-'))
        )
        const localRoot = path.join(base, 'data-vdc')
        const ossRoot = path.join(base, 'data-oss')
        const unmountedRoot = path.join(base, 'unmounted-root')
        await fs.mkdir(localRoot, { recursive: true })
        await fs.mkdir(ossRoot, { recursive: true })
        await fs.mkdir(unmountedRoot, { recursive: true })

        try {
            const serviceMounts: Mount[] = [
                {
                    Type: 'bind',
                    Source: localRoot,
                    Target: localRoot,
                    ReadOnly: false,
                },
                {
                    Type: 'bind',
                    Source: ossRoot,
                    Target: ossRoot,
                    ReadOnly: false,
                },
            ]
            const mountInfoText = [
                `100 1 8:1 / ${localRoot} rw,relatime - ext4 /dev/vda1 rw`,
                `101 1 0:50 / ${ossRoot} rw,nosuid,nodev - fuse.ossfs2 ossfs rw`,
            ].join('\n')

            const roots = await listApplicationVolumeRoots(
                'node-manager-1',
                serviceMounts,
                {
                    configuredRoots: `${localRoot}, ${ossRoot}, ${unmountedRoot}, ${localRoot}`,
                    mountInfoText,
                }
            )

            expect(roots).toEqual([
                {
                    root: localRoot,
                    node_id: 'node-manager-1',
                    backend: 'local-directory',
                    filesystem_type: 'ext4',
                    writable: true,
                    available: true,
                    total_bytes: expect.any(Number),
                    used_bytes: expect.any(Number),
                    free_bytes: expect.any(Number),
                    usage_ratio: expect.any(Number),
                },
                {
                    root: ossRoot,
                    node_id: 'node-manager-1',
                    backend: 'aliyun-oss-volume',
                    filesystem_type: 'fuse.ossfs2',
                    writable: true,
                    available: true,
                    total_bytes: expect.any(Number),
                    used_bytes: expect.any(Number),
                    free_bytes: expect.any(Number),
                    usage_ratio: expect.any(Number),
                },
                {
                    root: unmountedRoot,
                    node_id: 'node-manager-1',
                    backend: '',
                    filesystem_type: '',
                    writable: false,
                    available: false,
                    error: 'Storage root is outside the configured Deploy mounts',
                },
            ])
            expect(roots[0].total_bytes).toBeGreaterThan(0)
        } finally {
            await fs.rm(base, { recursive: true, force: true })
        }
    })
})

it('removes only an unreferenced application directory on its verified storage root', async () => {
    const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'opc-delete-volume-'))
    )
    const directory = 'app-35bc3c5a-7f8c-4bd0-80ec-58b7ea18c75e'
    const target = path.join(root, directory)
    const child = path.join(target, 'data')
    const foreignDirectory = path.join(root, 'keep')
    const alias = 'other-a2e34e6e-8aca-4c87-b05e-0b65ca692cf9'
    const mounts = [{ Type: 'bind', Source: root, Target: root }]
    const mountInfo = `100 1 8:1 / ${root} rw,relatime - xfs /dev/source rw`
    const options = { configuredRoots: root, mountInfoText: mountInfo }
    try {
        await fs.mkdir(child, { recursive: true })
        await fs.writeFile(path.join(child, 'state.json'), '{}')
        await fs.mkdir(foreignDirectory)
        await fs.symlink(foreignDirectory, path.join(root, alias))
        await expect(
            removeLocalApplicationVolumeDirectory(
                root,
                directory,
                mounts,
                async () => [child],
                options
            )
        ).rejects.toThrow('in use')
        await expect(
            removeLocalApplicationVolumeDirectory(
                root,
                directory,
                mounts,
                async () => [],
                {
                    ...options,
                    mountInfoText: `${mountInfo}\n101 1 8:1 / ${child} rw - xfs /dev/source rw`,
                }
            )
        ).rejects.toThrow('mount point')
        await expect(
            removeLocalApplicationVolumeDirectory(
                root,
                alias,
                mounts,
                async () => [],
                options
            )
        ).rejects.toThrow('not a local application directory')
        await expect(
            fs.readFile(path.join(child, 'state.json'), 'utf8')
        ).resolves.toBe('{}')
        for (const _ of [1, 2]) {
            await removeLocalApplicationVolumeDirectory(
                root,
                directory,
                mounts,
                async () => [],
                options
            )
        }
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fs.stat(foreignDirectory)).resolves.toBeDefined()
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

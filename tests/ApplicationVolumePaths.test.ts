import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type { Mount } from '../src/models/DockerService'
import { listApplicationVolumeRoots } from '../src/user/system/ApplicationVolumePaths'

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

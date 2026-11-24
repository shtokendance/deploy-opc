import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { PassThrough } from 'stream'
import * as tar from 'tar'
import type { Mount } from '../src/models/DockerService'
import {
    inspectApplicationVolumePaths,
    listApplicationVolumeRoots,
    removeLocalApplicationVolumeDirectory,
    streamApplicationVolumesTarGz,
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

describe('ApplicationVolumePaths.inspectAndExport', () => {
    it('inspects host volume directories and rejects paths outside configured roots', async () => {
        const base = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'opc-inspect-vol-'))
        )
        const root = path.join(base, 'data-vdc')
        const appDir = path.join(root, 'my-app-12345678-1234-1234-1234-1234567890ab')
        const dataDir = path.join(appDir, 'data')
        const outsideDir = path.join(base, 'outside')
        await fs.mkdir(path.join(dataDir, 'sub'), { recursive: true })
        await fs.mkdir(outsideDir, { recursive: true })
        await fs.writeFile(path.join(dataDir, 'state.json'), '{"ok":true}')
        await fs.writeFile(path.join(dataDir, 'sub', 'item.txt'), 'hello')
        await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'nope')

        const serviceMounts: Mount[] = [
            { Type: 'bind', Source: root, Target: root, ReadOnly: false },
        ]
        const mountInfoText = `100 1 8:1 / ${root} rw,relatime - ext4 /dev/vda1 rw`
        const options = { configuredRoots: root, mountInfoText }

        try {
            const missingDir = path.join(appDir, 'uploads')
            const stats = await inspectApplicationVolumePaths(
                [dataDir, missingDir],
                serviceMounts,
                options
            )
            expect(stats).toEqual([
                {
                    host_path: dataDir,
                    exists: true,
                    file_count: 2,
                    size_bytes: 16,
                    sample_files: ['state.json', 'sub/item.txt'],
                },
                {
                    host_path: missingDir,
                    exists: false,
                    file_count: 0,
                    size_bytes: 0,
                    sample_files: [],
                },
            ])

            await expect(
                inspectApplicationVolumePaths(
                    [outsideDir],
                    serviceMounts,
                    options
                )
            ).rejects.toThrow('outside the configured Deploy mounts')
        } finally {
            await fs.rm(base, { recursive: true, force: true })
        }
    })

    it('streams tar.gz archive preserving container paths and manifest.json, and enforces maxBytes', async () => {
        const base = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'opc-export-vol-'))
        )
        const root = path.join(base, 'data-vdc')
        const appDir = path.join(root, 'audit-12345678-1234-1234-1234-1234567890ab')
        const dataDir = path.join(appDir, 'data')
        const uploadsDir = path.join(appDir, 'uploads')
        const extractDir = path.join(base, 'extracted')
        await fs.mkdir(dataDir, { recursive: true })
        await fs.mkdir(path.join(uploadsDir, '2026'), { recursive: true })
        await fs.mkdir(extractDir, { recursive: true })
        await fs.writeFile(path.join(dataDir, 'db.json'), '{"v":1}')
        await fs.writeFile(path.join(uploadsDir, '2026', 'a.txt'), 'abcde')

        const serviceMounts: Mount[] = [
            { Type: 'bind', Source: root, Target: root, ReadOnly: false },
        ]
        const mountInfoText = `100 1 8:1 / ${root} rw,relatime - ext4 /dev/vda1 rw`
        const options = { configuredRoots: root, mountInfoText }

        try {
            await expect(
                streamApplicationVolumesTarGz(
                    {
                        app_slug: 'audit',
                        mounts: [],
                    },
                    serviceMounts,
                    new PassThrough(),
                    options
                )
            ).rejects.toThrow('No mounts')

            await expect(
                streamApplicationVolumesTarGz(
                    {
                        app_slug: 'audit',
                        mounts: [
                            { container_path: '/app/data', host_path: dataDir },
                            { container_path: '/app/uploads', host_path: uploadsDir },
                        ],
                        max_bytes: 8,
                    },
                    serviceMounts,
                    new PassThrough(),
                    options
                )
            ).rejects.toThrow('exceeds export limit')

            const archivePath = path.join(base, 'out.tar.gz')
            const fileHandle = await fs.open(archivePath, 'w')
            const writeStream = fileHandle.createWriteStream()
            await streamApplicationVolumesTarGz(
                {
                    app_slug: 'audit',
                    app_name: 'Audit App',
                    mounts: [
                        { container_path: '/app/data', host_path: dataDir },
                        { container_path: '/app/uploads', host_path: uploadsDir },
                    ],
                },
                serviceMounts,
                writeStream,
                options
            )

            await tar.extract({ file: archivePath, cwd: extractDir })
            const manifest = JSON.parse(
                await fs.readFile(path.join(extractDir, 'manifest.json'), 'utf8')
            )
            expect(manifest.app_slug).toBe('audit')
            expect(manifest.mounts).toHaveLength(2)
            expect(
                await fs.readFile(
                    path.join(extractDir, 'volumes/app/data/db.json'),
                    'utf8'
                )
            ).toBe('{"v":1}')
            expect(
                await fs.readFile(
                    path.join(extractDir, 'volumes/app/uploads/2026/a.txt'),
                    'utf8'
                )
            ).toBe('abcde')
        } finally {
            await fs.rm(base, { recursive: true, force: true })
        }
    })
})

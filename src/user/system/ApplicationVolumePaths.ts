import { createReadStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import type { Writable } from 'stream'
import { createGzip } from 'zlib'
import { Header, Pax } from 'tar'
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

export async function removeLocalApplicationVolumeDirectory(
    root: string,
    directory: string,
    serviceMounts: Mount[],
    readReferencedSources: () => Promise<string[]>,
    options?: { configuredRoots?: string; mountInfoText?: string }
) {
    if (
        !/^[a-z0-9][a-z0-9-]{0,62}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
            directory
        )
    ) {
        throw new Error('Invalid application volume directory')
    }
    const mountEntries = parseMountInfo(
        options?.mountInfoText ??
            (await fs.readFile('/proc/self/mountinfo', 'utf8'))
    )
    const { filesystem, rootStat } = await resolveVerifiedRoot(
        root,
        serviceMounts,
        mountEntries,
        parseConfiguredRoots(options?.configuredRoots)
    )
    if (filesystem.type.startsWith('fuse')) {
        throw new Error('Storage root is not a local filesystem')
    }
    const target = path.posix.join(root, directory)
    const stat = await fs
        .lstat(target)
        .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
        })
    if (!stat) return
    if (!stat.isDirectory() || stat.dev !== rootStat.dev) {
        throw new Error('Target is not a local application directory')
    }
    if (
        mountEntries.some(
            (entry) =>
                entry.target === target || entry.target.startsWith(target + '/')
        )
    ) {
        throw new Error('Application directory contains a mount point')
    }
    for (const raw of await readReferencedSources()) {
        if (!path.posix.isAbsolute(raw)) continue
        const source = path.posix.resolve(raw)
        const resolved = await fs.realpath(source).catch(() => source)
        if (
            [source, resolved].some(
                (entry) =>
                    entry === '/' ||
                    entry === target ||
                    entry.startsWith(target + '/') ||
                    target.startsWith(entry + '/')
            )
        ) {
            throw new Error('Application storage is still in use by Docker')
        }
    }
    await fs.rm(target, { recursive: true, force: true })
}

export interface ApplicationVolumePathStat {
    host_path: string
    exists: boolean
    file_count: number
    size_bytes: number
    sample_files: string[]
}

export interface ApplicationVolumeExportMount {
    container_path: string
    host_path: string
    name?: string
}

export interface ApplicationVolumeExportRequest {
    app_slug: string
    app_name?: string
    mounts: ApplicationVolumeExportMount[]
    max_bytes?: number
}

const DEFAULT_EXPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024

async function resolveVerifiedHostPath(
    hostPath: string,
    serviceMounts: Mount[],
    mountEntries: MountInfoEntry[],
    configuredRoots: string[]
): Promise<{ root: string; exists: boolean }> {
    if (!canonicalPath(hostPath)) {
        throw new Error('Storage root is outside the configured Deploy mounts')
    }
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
            hostPath.startsWith(entry + '/')
    )
    if (!allowed) {
        throw new Error('Storage root is outside the configured Deploy mounts')
    }
    await resolveVerifiedRoot(allowed, serviceMounts, mountEntries, configuredRoots)
    const stat = await fs
        .lstat(hostPath)
        .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
        })
    if (!stat) {
        return { root: allowed, exists: false }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Target is not a local application directory')
    }
    const real = await fs.realpath(hostPath)
    if (real !== hostPath) {
        throw new Error('Storage root is outside the configured Deploy mounts')
    }
    return { root: allowed, exists: true }
}

interface WalkedFile {
    absPath: string
    relPath: string
    size: number
    mode: number
    mtime: Date
}

async function walkDirectoryFiles(rootDir: string): Promise<WalkedFile[]> {
    const files: WalkedFile[] = []
    const queue: string[] = ['']
    while (queue.length > 0) {
        const relDir = queue.shift() || ''
        const absDir = relDir ? path.posix.join(rootDir, relDir) : rootDir
        const entries = await fs.readdir(absDir, { withFileTypes: true })
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue
            const relItem = relDir
                ? path.posix.join(relDir, entry.name)
                : entry.name
            const absItem = path.posix.join(rootDir, relItem)
            if (entry.isDirectory()) {
                queue.push(relItem)
            } else if (entry.isFile()) {
                const stat = await fs.lstat(absItem)
                if (!stat.isFile()) continue
                files.push({
                    absPath: absItem,
                    relPath: relItem,
                    size: stat.size,
                    mode: stat.mode & 0o777,
                    mtime: stat.mtime,
                })
            }
        }
    }
    return files
}

export async function inspectApplicationVolumePaths(
    hostPaths: string[],
    serviceMounts: Mount[],
    options?: { configuredRoots?: string; mountInfoText?: string }
): Promise<ApplicationVolumePathStat[]> {
    const configuredRoots = parseConfiguredRoots(options?.configuredRoots)
    const mountEntries = parseMountInfo(
        options?.mountInfoText ??
            (await fs.readFile('/proc/self/mountinfo', 'utf8'))
    )
    const results: ApplicationVolumePathStat[] = []
    for (const hostPath of hostPaths) {
        const trimmed = String(hostPath || '').trim()
        const { exists } = await resolveVerifiedHostPath(
            trimmed,
            serviceMounts,
            mountEntries,
            configuredRoots
        )
        if (!exists) {
            results.push({
                host_path: trimmed,
                exists: false,
                file_count: 0,
                size_bytes: 0,
                sample_files: [],
            })
            continue
        }
        const files = await walkDirectoryFiles(trimmed)
        let sizeBytes = 0
        for (const f of files) sizeBytes += f.size
        results.push({
            host_path: trimmed,
            exists: true,
            file_count: files.length,
            size_bytes: sizeBytes,
            sample_files: files.slice(0, 8).map((f) => f.relPath),
        })
    }
    return results
}

function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        if (stream.write(chunk)) {
            resolve()
            return
        }
        const onDrain = () => {
            cleanup()
            resolve()
        }
        const onError = (err: Error) => {
            cleanup()
            reject(err)
        }
        const cleanup = () => {
            stream.off('drain', onDrain)
            stream.off('error', onError)
        }
        stream.once('drain', onDrain)
        stream.once('error', onError)
    })
}

async function writeTarHeader(
    stream: Writable,
    entryPath: string,
    size: number,
    mode: number,
    mtime: Date
): Promise<void> {
    const header = new Header({
        path: entryPath,
        size,
        type: 'File',
        mode: mode || 0o644,
        mtime,
    })
    const needPax = header.encode()
    if (needPax) {
        const paxBuf = new Pax({ path: entryPath, size }).encode()
        await writeChunk(stream, paxBuf)
    }
    if (header.block) {
        await writeChunk(stream, header.block)
    }
}

async function writeTarPadding(stream: Writable, size: number): Promise<void> {
    const rem = size % 512
    if (rem > 0) {
        await writeChunk(stream, Buffer.alloc(512 - rem))
    }
}

async function pipeFileToTar(stream: Writable, filePath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(filePath)
        rs.on('data', (chunk: string | Buffer) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (!stream.write(buf)) {
                rs.pause()
                stream.once('drain', () => rs.resume())
            }
        })
        rs.once('end', () => resolve())
        rs.once('error', (err) => reject(err))
    })
}

export async function streamApplicationVolumesTarGz(
    req: ApplicationVolumeExportRequest,
    serviceMounts: Mount[],
    outputStream: Writable,
    options?: { configuredRoots?: string; mountInfoText?: string }
): Promise<void> {
    if (!req.mounts || req.mounts.length === 0) {
        throw new Error('No mounts specified for export')
    }
    const configuredRoots = parseConfiguredRoots(options?.configuredRoots)
    const mountEntries = parseMountInfo(
        options?.mountInfoText ??
            (await fs.readFile('/proc/self/mountinfo', 'utf8'))
    )
    const maxBytes =
        req.max_bytes && req.max_bytes > 0
            ? req.max_bytes
            : DEFAULT_EXPORT_MAX_BYTES

    const prepared: Array<{
        containerPath: string
        archivePrefix: string
        files: WalkedFile[]
        sizeBytes: number
    }> = []
    let totalBytes = 0

    for (const m of req.mounts) {
        const containerPath = path.posix.normalize(
            String(m.container_path || '').trim()
        )
        const hostPath = String(m.host_path || '').trim()
        if (!containerPath.startsWith('/') || containerPath === '/') {
            throw new Error(`Invalid container_path: ${m.container_path}`)
        }
        const { exists } = await resolveVerifiedHostPath(
            hostPath,
            serviceMounts,
            mountEntries,
            configuredRoots
        )
        const files = exists ? await walkDirectoryFiles(hostPath) : []
        let mountBytes = 0
        for (const f of files) mountBytes += f.size
        totalBytes += mountBytes
        if (totalBytes > maxBytes) {
            throw new Error('Volume data exceeds export limit')
        }
        const cleanRel = containerPath.replace(/^\/+/, '')
        prepared.push({
            containerPath,
            archivePrefix: `volumes/${cleanRel}`,
            files,
            sizeBytes: mountBytes,
        })
    }

    const manifest = {
        app_slug: req.app_slug,
        app_name: req.app_name || req.app_slug,
        exported_at: new Date().toISOString(),
        total_bytes: totalBytes,
        mounts: prepared.map((p) => ({
            container_path: p.containerPath,
            archive_path: `${p.archivePrefix}/`,
            file_count: p.files.length,
            size_bytes: p.sizeBytes,
        })),
    }
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')

    const gzip = createGzip()
    const done = new Promise<void>((resolve, reject) => {
        outputStream.once('finish', resolve)
        outputStream.once('error', reject)
        gzip.once('error', reject)
    })
    gzip.pipe(outputStream)

    try {
        await writeTarHeader(
            gzip,
            'manifest.json',
            manifestBuf.length,
            0o644,
            new Date()
        )
        await writeChunk(gzip, manifestBuf)
        await writeTarPadding(gzip, manifestBuf.length)

        for (const p of prepared) {
            for (const f of p.files) {
                const archivePath = path.posix.join(p.archivePrefix, f.relPath)
                await writeTarHeader(
                    gzip,
                    archivePath,
                    f.size,
                    f.mode,
                    f.mtime
                )
                if (f.size > 0) {
                    await pipeFileToTar(gzip, f.absPath)
                    await writeTarPadding(gzip, f.size)
                }
            }
        }

        await writeChunk(gzip, Buffer.alloc(1024))
        gzip.end()
        await done
    } catch (err) {
        gzip.destroy()
        throw err
    }
}

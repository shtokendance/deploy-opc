import DockerApi from '../src/docker/DockerApi'

test('getServiceResourceMetrics aggregates cpu, memory, disk, and io from docker container', async () => {
    const dockerApi = new DockerApi({})
    const fakeDockerode = {
        getService: () => ({
            inspect: async () => ({
                ID: 'svc-1',
                Spec: {
                    Mode: { Replicated: { Replicas: 1 } },
                    TaskTemplate: {
                        Resources: {
                            Limits: {
                                NanoCPUs: 2_000_000_000,
                                MemoryBytes: 1024 * 1024 * 1024,
                            },
                        },
                    },
                },
            }),
        }),
        listTasks: async () => [
            {
                NodeID: 'node-1',
                Status: {
                    State: 'running',
                    ContainerStatus: { ContainerID: 'container-1' },
                },
            },
        ],
        listNodes: async () => [
            {
                ID: 'node-1',
                Description: {
                    Hostname: 'swarm-worker-1',
                    Resources: {
                        NanoCPUs: 4_000_000_000,
                        MemoryBytes: 8 * 1024 * 1024 * 1024,
                    },
                },
            },
        ],
        getContainer: () => ({
            stats: async () => ({
                cpu_stats: {
                    cpu_usage: { total_usage: 250_000_000, percpu_usage: [1, 2, 3, 4] },
                    system_cpu_usage: 2_000_000_000,
                    online_cpus: 4,
                },
                precpu_stats: {
                    cpu_usage: { total_usage: 150_000_000 },
                    system_cpu_usage: 1_000_000_000,
                },
                memory_stats: {
                    usage: 300 * 1024 * 1024,
                    limit: 8 * 1024 * 1024 * 1024,
                    stats: { inactive_file: 44 * 1024 * 1024 },
                },
                networks: {
                    eth0: { rx_bytes: 1200, tx_bytes: 3400 },
                },
                blkio_stats: {
                    io_service_bytes_recursive: [
                        { op: 'Read', value: 4096 },
                        { op: 'Write', value: 8192 },
                    ],
                },
                pids_stats: { current: 24 },
            }),
            inspect: async () => ({
                SizeRw: 12_500_000,
                SizeRootFs: 420_000_000,
                RestartCount: 1,
                State: { StartedAt: '2026-11-27T08:00:00Z' },
            }),
        }),
    }
    ;(dockerApi as unknown as { dockerode: unknown }).dockerode = fakeDockerode

    const metrics = await dockerApi.getServiceResourceMetrics('srv-captain--demo')

    expect(metrics.available).toBe(true)
    expect(metrics.replicas_running).toBe(1)
    expect(metrics.replicas_desired).toBe(1)
    expect(metrics.cpu_percent).toBe(40)
    expect(metrics.cpu_limit_cores).toBe(2)
    expect(metrics.online_cpus).toBe(4)
    expect(metrics.memory_usage_bytes).toBe(256 * 1024 * 1024)
    expect(metrics.memory_limit_bytes).toBe(1024 * 1024 * 1024)
    expect(metrics.memory_percent).toBe(25)
    expect(metrics.container_rw_bytes).toBe(12_500_000)
    expect(metrics.container_rootfs_bytes).toBe(420_000_000)
    expect(metrics.network_rx_bytes).toBe(1200)
    expect(metrics.network_tx_bytes).toBe(3400)
    expect(metrics.block_read_bytes).toBe(4096)
    expect(metrics.block_write_bytes).toBe(8192)
    expect(metrics.pids).toBe(24)
    expect(metrics.restart_count).toBe(1)
    expect(metrics.node_hostname).toBe('swarm-worker-1')
})

test('getServiceResourceMetrics returns unavailable when service is missing', async () => {
    const dockerApi = new DockerApi({})
    const fakeDockerode = {
        getService: () => ({
            inspect: async () => {
                const err = new Error('not found') as Error & { statusCode?: number }
                err.statusCode = 404
                throw err
            },
        }),
    }
    ;(dockerApi as unknown as { dockerode: unknown }).dockerode = fakeDockerode

    const metrics = await dockerApi.getServiceResourceMetrics('srv-captain--missing')

    expect(metrics.available).toBe(false)
    expect(metrics.message).toBe('Service not found')
})

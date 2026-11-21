import Docker = require('dockerode')
import {
    candidateServiceImages,
    startDeliveryCandidate,
    stopDeliveryCandidate,
} from '../src/docker/DeliveryCandidate'

test('candidate services and temporary volumes are owned by the delivery and cleaned up', async () => {
    const receipt = '12345678-1234-1234-1234-123456789abc'
    const prefix = `opc-candidate-${receipt}`
    const instances = new Map<string, Docker.ContainerCreateOptions>()
    const removed: string[] = []
    const running = new Set<string>()
    const fixture = {
        getContainer: (name: string) => ({
            inspect: async () => {
                if (!name.startsWith(prefix)) return { Image: 'deploy-image' }
                const spec = instances.get(name)
                if (!spec)
                    throw Object.assign(new Error('missing'), {
                        statusCode: 404,
                    })
                return {
                    Id: name,
                    Config: { Image: spec.Image, Labels: spec.Labels },
                    HostConfig: spec.HostConfig,
                    State: {
                        Running: running.has(name),
                        Health: { Status: 'healthy' },
                    },
                }
            },
            start: async () => {
                running.add(name)
            },
            remove: async (options: Docker.ContainerRemoveOptions) => {
                expect(options).toEqual({ force: true, v: true })
                removed.push(name)
                instances.delete(name)
            },
        }),
        createContainer: async (spec: Docker.ContainerCreateOptions) => {
            instances.set(spec.name!, spec)
        },
        listContainers: async () => [
            { Id: `${prefix}-service-5432` },
            { Id: `${prefix}-service-6379` },
        ],
    }
    const docker = fixture as unknown as Docker
    const sandbox = {
        services: [
            { kind: 'postgres' as const, port: 5432, password: 'a'.repeat(32) },
            { kind: 'redis' as const, port: 6379 },
        ],
        mounts: ['/data/attachments'],
    }
    await startDeliveryCandidate(
        docker,
        'demo',
        receipt,
        'app-image',
        [],
        sandbox
    )
    await startDeliveryCandidate(
        docker,
        'demo',
        receipt,
        'app-image',
        [],
        sandbox
    )
    expect(instances).toHaveProperty('size', 4)
    expect(instances.get(`${prefix}-sandbox`)?.HostConfig?.NetworkMode).toBe(
        'none'
    )
    for (const name of [
        prefix,
        `${prefix}-service-5432`,
        `${prefix}-service-6379`,
    ]) {
        expect(instances.get(name)?.HostConfig).toMatchObject({
            NetworkMode: `container:${prefix}-sandbox`,
        })
        expect(instances.get(name)?.HostConfig?.Binds).toBeUndefined()
    }
    expect(instances.get(prefix)?.Volumes).toEqual({ '/data/attachments': {} })
    expect(instances.get(`${prefix}-service-5432`)?.Image).toBe(
        candidateServiceImages.postgres
    )
    await expect(
        startDeliveryCandidate(docker, 'demo', receipt, 'app-image', [], {
            ...sandbox,
            mounts: [],
        })
    ).rejects.toThrow('not owned')
    await stopDeliveryCandidate(docker, 'demo', receipt)
    expect(removed).toEqual([
        prefix,
        `${prefix}-service-5432`,
        `${prefix}-service-6379`,
        `${prefix}-sandbox`,
    ])
})

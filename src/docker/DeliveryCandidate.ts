import Docker = require('dockerode')
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { IAppEnvVar } from '../models/AppDefinition'

const candidateLabel = 'com.opc.delivery-candidate'
const appLabel = 'com.opc.delivery-app'
const relayLabel = 'com.opc.delivery-candidate-relay'
const componentLabel = 'com.opc.delivery-candidate-component'
const configLabel = 'com.opc.delivery-candidate-config'
const maxOutput = 512 * 1024

export const candidateServiceImages = {
    postgres: process.env.OPC_PREVIEW_POSTGRES_IMAGE || 'postgres:16-alpine',
    redis: process.env.OPC_PREVIEW_REDIS_IMAGE || 'redis:7.4-alpine',
}
const databaseName = 'opc_preview'

export interface CandidateService {
    kind: keyof typeof candidateServiceImages
    port: number
    password?: string
}

export interface CandidateSandbox {
    services: CandidateService[]
    mounts: string[]
}

export interface CandidateRequest {
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
}

export interface CandidateResponse {
    status: number
    headers: Record<string, string[]>
    body: string
}

// Both the probe and scratch services share a loopback-only network namespace.
const probeScript = `
const http = require('node:http');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const { method, path, headers, body, port } = JSON.parse(input);
  const request = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, result => {
    const chunks = [];
    let size = 0;
    result.on('data', chunk => {
      size += chunk.length;
      if (size > 262144) request.destroy(new Error('response too large'));
      else chunks.push(chunk);
    });
    result.on('end', () => {
      clearTimeout(timer);
      process.stdout.write(JSON.stringify({ status: result.statusCode,
        headers: result.headersDistinct, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  const timer = setTimeout(() => request.destroy(new Error('request timed out')), 10000);
  request.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
  request.end(body);
});
`

function candidateName(receipt: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt)) {
        throw new Error('Invalid delivery candidate receipt')
    }
    return `opc-candidate-${receipt}`
}

function dockerStatus(error: unknown): number | undefined {
    return typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined
}

async function ownedContainer(
    docker: Docker,
    name: string,
    labels: Record<string, string>
) {
    const container = docker.getContainer(name)
    try {
        const info = await container.inspect()
        for (const [key, value] of Object.entries(labels)) {
            if (info.Config.Labels?.[key] !== value) {
                throw new Error('Container is not owned by this delivery')
            }
        }
        return { container, info }
    } catch (error) {
        if (dockerStatus(error) === 404) return undefined
        throw error
    }
}

async function ensureCandidateContainer(
    docker: Docker,
    name: string,
    labels: Record<string, string>,
    spec: Docker.ContainerCreateOptions
) {
    let existing = await ownedContainer(docker, name, labels)
    if (!existing) {
        try {
            await docker.createContainer({
                ...spec,
                name,
                Labels: { ...spec.Labels, ...labels },
            })
        } catch (error) {
            if (dockerStatus(error) !== 409) throw error
        }
        existing = await ownedContainer(docker, name, labels)
    }
    if (
        !existing ||
        existing.info.Config.Image !== spec.Image ||
        existing.info.HostConfig.NetworkMode !== spec.HostConfig?.NetworkMode
    ) {
        throw new Error('Delivery candidate does not match its isolated image')
    }
    if (!existing.info.State.Running) {
        try {
            await existing.container.start()
        } catch (error) {
            if (dockerStatus(error) !== 304) throw error
        }
    }
    return existing
}

async function candidateProbeContainer(
    docker: Docker,
    name: string,
    labels: Record<string, string>,
    networkMode: string
) {
    const self = await docker.getContainer(hostname()).inspect()
    return ensureCandidateContainer(docker, name, labels, {
        Image: self.Image,
        ...(networkMode === 'none' ? { Hostname: 'localhost' } : {}),
        Entrypoint: ['node'],
        Cmd: ['-e', 'setInterval(() => {}, 2147483647)'],
        HostConfig: {
            NetworkMode: networkMode,
            CapDrop: ['ALL'],
            ReadonlyRootfs: true,
            SecurityOpt: ['no-new-privileges:true'],
        },
    })
}

async function startCandidateService(
    docker: Docker,
    name: string,
    labels: Record<string, string>,
    networkMode: string,
    service: CandidateService
) {
    const port = String(service.port)
    const postgres = service.kind === 'postgres'
    const env = postgres
        ? [
              `POSTGRES_DB=${databaseName}`,
              `POSTGRES_USER=${databaseName}`,
              `POSTGRES_PASSWORD=${service.password}`,
          ]
        : service.password
          ? [`REDISCLI_AUTH=${service.password}`]
          : []
    const command = postgres
        ? ['postgres', '-c', 'listen_addresses=127.0.0.1', '-p', port]
        : [
              'redis-server',
              '--bind',
              '127.0.0.1',
              '--port',
              port,
              ...(service.password ? ['--requirepass', service.password] : []),
          ]
    const check = postgres
        ? [
              'pg_isready',
              '-h',
              '127.0.0.1',
              '-p',
              port,
              '-d',
              databaseName,
              '-U',
              databaseName,
          ]
        : ['redis-cli', '-h', '127.0.0.1', '-p', port, 'ping']
    const instance = await ensureCandidateContainer(docker, name, labels, {
        Image: candidateServiceImages[service.kind],
        Cmd: command,
        Env: env,
        HostConfig: {
            NetworkMode: networkMode,
            SecurityOpt: ['no-new-privileges:true'],
            Memory: 512 * 1024 * 1024,
            PidsLimit: 128,
        },
        Healthcheck: {
            Test: ['CMD', ...check],
            Interval: 1_000_000_000,
            Timeout: 1_000_000_000,
            Retries: 45,
        },
    })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
        const { State } = await instance.container.inspect()
        if (State.Health?.Status === 'healthy') return
        if (!State.Running || State.Health?.Status === 'unhealthy') break
        await delay(500)
    }
    throw new Error(
        `Temporary ${service.kind} did not become ready on port ${port}`
    )
}

export async function startDeliveryCandidate(
    docker: Docker,
    app: string,
    receipt: string,
    image: string,
    env: IAppEnvVar[],
    sandbox: CandidateSandbox
) {
    const name = candidateName(receipt)
    const labels = { [candidateLabel]: receipt, [appLabel]: app }
    const usesSandbox = sandbox.services.length > 0 || sandbox.mounts.length > 0
    const config = createHash('sha256')
        .update(JSON.stringify({ env, sandbox }))
        .digest('hex')
    const candidateLabels = usesSandbox
        ? { ...labels, [configLabel]: config }
        : labels
    let networkMode = 'none'
    if (sandbox.services.length > 0) {
        const holder = await candidateProbeContainer(
            docker,
            `${name}-sandbox`,
            { ...labels, [componentLabel]: 'sandbox', [configLabel]: config },
            'none'
        )
        networkMode = `container:${holder.info.Id}`
        const provisioned = await Promise.allSettled(
            sandbox.services.map((service) =>
                startCandidateService(
                    docker,
                    `${name}-service-${service.port}`,
                    {
                        ...labels,
                        [componentLabel]: 'service',
                        [configLabel]: config,
                    },
                    networkMode,
                    service
                )
            )
        )
        const failed = provisioned.find(
            (result) => result.status === 'rejected'
        )
        if (failed) throw failed.reason
    }
    await ensureCandidateContainer(docker, name, candidateLabels, {
        Image: image,
        // Containers joining the sandbox inherit its loopback hostname.
        ...(networkMode === 'none' ? { Hostname: 'localhost' } : {}),
        Labels: { [componentLabel]: 'app' },
        Env: env.map(({ key, value }) => `${key}=${value}`),
        Volumes: Object.fromEntries(sandbox.mounts.map((path) => [path, {}])),
        HostConfig: {
            NetworkMode: networkMode,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            PidsLimit: 512,
            LogConfig: {
                Type: 'json-file',
                Config: { 'max-size': '2m', 'max-file': '1' },
            },
        },
    })
}

export async function stopDeliveryCandidate(
    docker: Docker,
    app: string,
    receipt: string
) {
    const name = candidateName(receipt)
    const labels = { [candidateLabel]: receipt, [appLabel]: app }
    const relay = await ownedContainer(docker, `${name}-relay`, {
        ...labels,
        [relayLabel]: 'true',
    })
    const candidate = await ownedContainer(docker, name, labels)
    const holder = await ownedContainer(docker, `${name}-sandbox`, {
        ...labels,
        [componentLabel]: 'sandbox',
    })
    const services = await docker.listContainers({
        all: true,
        filters: {
            label: [
                `${candidateLabel}=${receipt}`,
                `${appLabel}=${app}`,
                `${componentLabel}=service`,
            ],
        },
    })
    const dependencies = await Promise.all(
        services.map(({ Id }) =>
            ownedContainer(docker, Id, {
                ...labels,
                [componentLabel]: 'service',
            })
        )
    )
    for (const item of [relay, candidate, ...dependencies, holder]) {
        if (!item) continue
        try {
            await item.container.remove({ force: true, v: true })
        } catch (error) {
            if (dockerStatus(error) !== 404) throw error
        }
    }
}

export async function getDeliveryCandidateLogs(
    docker: Docker,
    app: string,
    receipt: string
) {
    const candidate = await ownedContainer(docker, candidateName(receipt), {
        [candidateLabel]: receipt,
        [appLabel]: app,
    })
    if (!candidate)
        throw new Error('Isolated delivery candidate is not available')
    const output = await candidate.container.logs({
        stdout: true,
        stderr: true,
        tail: 100,
    })
    let logs = ''
    for (let offset = 0; offset + 8 <= output.length;) {
        const end = offset + 8 + output.readUInt32BE(offset + 4)
        if (end > output.length) break
        logs = (logs + output.toString('utf8', offset + 8, end)).slice(-12000)
        offset = end
    }
    return `Candidate container state: ${candidate.info.State.Status} (exit ${candidate.info.State.ExitCode})\n${logs}`
}

export async function probeDeliveryCandidate(
    docker: Docker,
    app: string,
    receipt: string,
    port: number,
    request: CandidateRequest
): Promise<CandidateResponse> {
    const name = candidateName(receipt)
    const labels = { [candidateLabel]: receipt, [appLabel]: app }
    const candidate = await ownedContainer(docker, name, labels)
    if (!candidate?.info.State.Running) {
        throw new Error('Isolated delivery candidate is not running')
    }
    const mode = candidate.info.HostConfig.NetworkMode
    const relay =
        mode === 'none'
            ? await candidateProbeContainer(
                  docker,
                  `${name}-relay`,
                  { ...labels, [relayLabel]: 'true' },
                  `container:${candidate.info.Id}`
              )
            : await ownedContainer(docker, `${name}-sandbox`, {
                  ...labels,
                  [componentLabel]: 'sandbox',
              })
    if (
        !relay ||
        (mode !== 'none' &&
            (!relay.info.State.Running ||
                relay.info.HostConfig.NetworkMode !== 'none' ||
                mode !== `container:${relay.info.Id}`))
    ) {
        throw new Error('Isolated candidate network namespace is not available')
    }
    const exec = await relay.container.exec({
        Cmd: ['node', '-e', probeScript],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
    })
    const stream = await exec.start({ hijack: true, stdin: true })
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stderr.resume()
    let size = 0
    const chunks: Buffer[] = []
    docker.modem.demuxStream(stream, stdout, stderr)
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () => stream.destroy(new Error('Candidate probe timeout')),
            12000
        )
        stdout.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > maxOutput)
                stream.destroy(new Error('Candidate response too large'))
            else chunks.push(chunk)
        })
        stream.once('error', reject)
        stream.once('end', resolve)
        stream.once('close', () => {
            clearTimeout(timeout)
            resolve()
        })
        // A full HTTP request is sent through the Docker exec input stream.
        stream.end(JSON.stringify({ ...request, port }))
    })
    if (chunks.length === 0)
        throw new Error('Candidate did not return an HTTP response')
    return JSON.parse(
        Buffer.concat(chunks).toString('utf8')
    ) as CandidateResponse
}

import Docker = require('dockerode')
import { hostname } from 'node:os'
import { PassThrough } from 'node:stream'
import { IAppEnvVar } from '../models/AppDefinition'

const candidateLabel = 'com.opc.delivery-candidate'
const appLabel = 'com.opc.delivery-app'
const relayLabel = 'com.opc.delivery-candidate-relay'
const maxOutput = 512 * 1024

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

// Run the relay in the candidate's network namespace. The only peer the
// application's process can reach is loopback, and the relay has no host mounts.
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

export async function startDeliveryCandidate(
    docker: Docker,
    app: string,
    receipt: string,
    image: string,
    env: IAppEnvVar[]
) {
    const name = candidateName(receipt)
    const labels = { [candidateLabel]: receipt, [appLabel]: app }
    let existing = await ownedContainer(docker, name, labels)
    if (!existing) {
        try {
            await docker.createContainer({
                name,
                Image: image,
                Env: env.map(({ key, value }) => `${key}=${value}`),
                Labels: labels,
                HostConfig: {
                    NetworkMode: 'none',
                    CapDrop: ['ALL'],
                    SecurityOpt: ['no-new-privileges:true'],
                    PidsLimit: 512,
                    LogConfig: {
                        Type: 'json-file',
                        Config: { 'max-size': '2m', 'max-file': '1' },
                    },
                },
            })
        } catch (error) {
            if (dockerStatus(error) !== 409) throw error
        }
        existing = await ownedContainer(docker, name, labels)
    }
    if (
        !existing ||
        existing.info.Config.Image !== image ||
        existing.info.HostConfig.NetworkMode !== 'none'
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
    for (const item of [relay, candidate]) {
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
    if (
        !candidate?.info.State.Running ||
        candidate.info.HostConfig.NetworkMode !== 'none'
    ) {
        throw new Error('Isolated delivery candidate is not running')
    }
    const relayName = `${name}-relay`
    const relayLabels = { ...labels, [relayLabel]: 'true' }
    const networkMode = `container:${candidate.info.Id}`
    let relay = await ownedContainer(docker, relayName, relayLabels)
    if (!relay) {
        const self = await docker.getContainer(hostname()).inspect()
        try {
            await docker.createContainer({
                name: relayName,
                Image: self.Image,
                Entrypoint: ['node'],
                Cmd: ['-e', 'setInterval(() => {}, 2147483647)'],
                Labels: relayLabels,
                HostConfig: {
                    NetworkMode: networkMode,
                    CapDrop: ['ALL'],
                    ReadonlyRootfs: true,
                    SecurityOpt: ['no-new-privileges:true'],
                },
            })
        } catch (error) {
            if (dockerStatus(error) !== 409) throw error
        }
        relay = await ownedContainer(docker, relayName, relayLabels)
    }
    if (!relay || relay.info.HostConfig.NetworkMode !== networkMode) {
        throw new Error('Isolated candidate relay is not available')
    }
    if (!relay.info.State.Running) {
        try {
            await relay.container.start()
        } catch (error) {
            if (dockerStatus(error) !== 304) throw error
        }
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

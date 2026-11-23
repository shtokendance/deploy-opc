import express = require('express')
import ApiStatusCodes from '../../../../api/ApiStatusCodes'
import BaseApi from '../../../../api/BaseApi'
import InjectionExtractor from '../../../../injection/InjectionExtractor'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { posix } from 'node:path'
import type { CandidateService } from '../../../../docker/DeliveryCandidate'

const router = express.Router()

router.get('/', function (req, res, next) {
    const serviceManager =
        InjectionExtractor.extractUserFromInjected(res).user.serviceManager

    return Promise.resolve()
        .then(function () {
            return serviceManager.getAppsRuntime()
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'App runtime information retrieved.'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/:appName', function (req, res, next) {
    const serviceManager =
        InjectionExtractor.extractUserFromInjected(res).user.serviceManager
    const appName = req.params.appName

    return Promise.resolve()
        .then(function () {
            return serviceManager.getAppRuntime(appName)
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'App runtime information retrieved.'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post<{ appName: string }>(
    '/:appName/restart',
    async function (req, res) {
        const { serviceManager } =
            InjectionExtractor.extractUserFromInjected(res).user
        try {
            const { operationId, changes = [] } = req.body || {}
            if (
                typeof operationId !== 'string' ||
                !/^[a-f0-9-]{36}$/.test(operationId) ||
                !Array.isArray(changes) ||
                changes.length > 256 ||
                changes.some(
                    (item) =>
                        !item ||
                        typeof item.key !== 'string' ||
                        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(item.key) ||
                        typeof item.value !== 'string' ||
                        item.value.includes('\0')
                )
            ) {
                throw ApiStatusCodes.createError(
                    ApiStatusCodes.ILLEGAL_PARAMETER,
                    'Invalid application restart request'
                )
            }
            await serviceManager.restartApplication(
                req.params.appName,
                operationId,
                changes
            )
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK,
                    'Application restart submitted'
                )
            )
        } catch (error) {
            ApiStatusCodes.createCatcher(res)(error)
        }
    }
)

router.get('/:appName/write-hold', function (req, res) {
    const { serviceManager } =
        InjectionExtractor.extractUserFromInjected(res).user
    return serviceManager
        .isApplicationWriteHeld(req.params.appName)
        .then(function (held) {
            const reply = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Application write hold state'
            )
            reply.data = { held }
            res.send(reply)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/:appName/write-hold', function (req, res) {
    const { serviceManager } =
        InjectionExtractor.extractUserFromInjected(res).user
    if (typeof req.body?.hold !== 'boolean') {
        return res.send(
            new BaseApi(
                ApiStatusCodes.ILLEGAL_PARAMETER,
                'hold must be boolean'
            )
        )
    }
    return serviceManager
        .setApplicationWriteHold(req.params.appName, req.body.hold)
        .then(function () {
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK,
                    'Application replica adjustment requested'
                )
            )
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

const hopByHop = new Set([
    'connection',
    'content-length',
    'expect',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
])

router.post<{ appName: string; receipt: string }>(
    ['/:appName/candidates/:receipt', '/:appName/candidates/:receipt/sandbox'],
    async function (req, res) {
        const { serviceManager } =
            InjectionExtractor.extractUserFromInjected(res).user
        try {
            const env: unknown = req.body?.env
            if (
                !Array.isArray(env) ||
                env.length > 500 ||
                env.some(
                    (item) =>
                        typeof item?.key !== 'string' ||
                        !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(item.key) ||
                        typeof item?.value !== 'string' ||
                        item.value.includes('\0')
                )
            )
                throw new Error('Invalid candidate environment')
            const services: unknown = req.body?.services ?? []
            const mounts: unknown = req.body?.mounts ?? []
            if (
                !Array.isArray(services) ||
                services.length > 8 ||
                !services.every(isCandidateService) ||
                new Set(services.map((service) => service.port)).size !==
                    services.length
            ) {
                throw new Error('Invalid temporary candidate services')
            }
            if (
                !Array.isArray(mounts) ||
                !mounts.every(
                    (path) =>
                        typeof path === 'string' &&
                        path.startsWith('/') &&
                        path !== '/' &&
                        posix.normalize(path) === path &&
                        !path.endsWith('/') &&
                        !path.includes('\0') &&
                        !/^\/(dev|proc|sys)(\/|$)/.test(path)
                ) ||
                new Set(mounts).size !== mounts.length
            ) {
                throw new Error('Invalid temporary candidate mount paths')
            }
            await serviceManager.startDeliveryCandidate(
                req.params.appName,
                req.params.receipt,
                env,
                { services, mounts }
            )
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK,
                    'Isolated delivery candidate started'
                )
            )
        } catch (error) {
            ApiStatusCodes.createCatcher(res)(error)
        }
    }
)

function isCandidateService(value: unknown): value is CandidateService {
    if (!value || typeof value !== 'object') return false
    const { kind, port, password } = value as Partial<CandidateService>
    const hasPassword =
        typeof password === 'string' && /^[a-f0-9]{32}$/.test(password)
    return (
        typeof port === 'number' &&
        Number.isInteger(port) &&
        port >= 1024 &&
        port <= 65535 &&
        ((kind === 'postgres' && hasPassword) ||
            (kind === 'redis' && (password === undefined || hasPassword)))
    )
}

router.delete<{ appName: string; receipt: string }>(
    '/:appName/candidates/:receipt',
    async function (req, res) {
        const { serviceManager } =
            InjectionExtractor.extractUserFromInjected(res).user
        try {
            await serviceManager.stopDeliveryCandidate(
                req.params.appName,
                req.params.receipt
            )
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK,
                    'Isolated delivery candidate removed'
                )
            )
        } catch (error) {
            ApiStatusCodes.createCatcher(res)(error)
        }
    }
)

router.get<{ appName: string; receipt: string }>(
    '/:appName/candidates/:receipt/logs',
    async function (req, res) {
        const { serviceManager } =
            InjectionExtractor.extractUserFromInjected(res).user
        try {
            const logs = await serviceManager.getDeliveryCandidateLogs(
                req.params.appName,
                req.params.receipt
            )
            const reply = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Isolated delivery candidate logs'
            )
            reply.data = { logs }
            res.send(reply)
        } catch (error) {
            ApiStatusCodes.createCatcher(res)(error)
        }
    }
)

router.post<{ appName: string; receipt: string }>(
    '/:appName/candidates/:receipt/probe',
    async function (req, res) {
        const { serviceManager } =
            InjectionExtractor.extractUserFromInjected(res).user
        try {
            const { body, method, path, port } = req.body || {}
            if (
                ![
                    'GET',
                    'HEAD',
                    'POST',
                    'PUT',
                    'PATCH',
                    'DELETE',
                    'OPTIONS',
                ].includes(method) ||
                typeof path !== 'string' ||
                path.length > 4096 ||
                !path.startsWith('/') ||
                path.startsWith('//') ||
                Array.from(path).some(
                    (character) =>
                        character <= ' ' ||
                        character === '\u007f' ||
                        character === '\\'
                ) ||
                !Number.isSafeInteger(port) ||
                port < 1 ||
                port > 65535 ||
                (body !== undefined &&
                    (typeof body !== 'string' ||
                        Buffer.byteLength(body) > 64 * 1024))
            ) {
                throw new Error('Invalid candidate HTTP request')
            }
            const inputHeaders: unknown = req.body?.headers
            const headers: Record<string, string> = Object.create(null)
            if (inputHeaders !== undefined) {
                if (
                    inputHeaders === null ||
                    typeof inputHeaders !== 'object' ||
                    Array.isArray(inputHeaders)
                ) {
                    throw new Error('Invalid candidate HTTP headers')
                }
                for (const [key, value] of Object.entries(inputHeaders)) {
                    if (typeof value !== 'string' || value.length > 8192)
                        throw new Error('Invalid candidate HTTP header value')
                    validateHeaderName(key)
                    validateHeaderValue(key, value)
                    if (!hopByHop.has(key.toLowerCase())) headers[key] = value
                }
            }
            const result = await serviceManager.probeDeliveryCandidate(
                req.params.appName,
                req.params.receipt,
                port,
                { method, path, body, headers }
            )
            const reply = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Isolated delivery candidate HTTP response'
            )
            reply.data = result
            res.send(reply)
        } catch (error) {
            ApiStatusCodes.createCatcher(res)(error)
        }
    }
)

export default router

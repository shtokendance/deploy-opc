import express = require('express')
import ApiStatusCodes from '../../../../api/ApiStatusCodes'
import BaseApi from '../../../../api/BaseApi'
import InjectionExtractor from '../../../../injection/InjectionExtractor'

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

export default router

import express = require('express')
import ApiStatusCodes from '../../../../api/ApiStatusCodes'
import BaseApi from '../../../../api/BaseApi'
import {
    parseCandidateBuildArgs,
    uploadCaptainDefinitionContent as uploadCaptainDefinitionContentHandler,
} from '../../../../handlers/users/apps/appdata/AppDataHandler'
import InjectionExtractor from '../../../../injection/InjectionExtractor'
import fs from 'fs-extra'
import multer = require('multer')

const TEMP_UPLOAD = 'temp_upload/'
const router = express.Router()
const upload = multer({
    dest: TEMP_UPLOAD,
})

router.get('/:appName/logs', function (req, res, next) {
    const appName = req.params.appName
    const serviceManager =
        InjectionExtractor.extractUserFromInjected(res).user.serviceManager

    return Promise.resolve()
        .then(function () {
            const encoding = req.query.encoding as string
            return serviceManager.getAppLogs(
                appName,
                encoding ? encoding : 'ascii'
            )
        })
        .then(function (logs) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'App runtime logs are retrieved'
            )
            baseApi.data = { logs }
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/:appName/', function (req, res, next) {
    const appName = req.params.appName
    const serviceManager =
        InjectionExtractor.extractUserFromInjected(res).user.serviceManager

    return Promise.resolve()
        .then(function () {
            return serviceManager.getBuildStatus(appName)
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'App build status retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/:appName/builds/:receipt', function (req, res) {
    const { dataStore, serviceManager } =
        InjectionExtractor.extractUserFromInjected(res).user
    const { appName, receipt } = req.params
    return dataStore
        .getAppsDataStore()
        .getAppDefinition(appName)
        .then(function (app) {
            const build = app.versions.find(
                (version) => version.preparedBuild?.receipt === receipt
            )?.preparedBuild
            const reply = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Prepared build receipt'
            )
            const pending = serviceManager.candidateBuildState(appName, receipt)
            reply.data =
                build || pending
                    ? {
                          status: build?.image
                              ? 'built'
                              : build?.error
                                ? 'failed'
                                : (pending ?? 'unknown'),
                          image: build?.image,
                          error: build?.error,
                          log:
                              build?.image || build?.error
                                  ? build.log
                                  : serviceManager.getCandidateBuildLog(
                                        appName,
                                        receipt
                                    ),
                      }
                    : { status: 'unknown' }
            res.send(reply)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.delete('/:appName/builds/:receipt', async function (req, res) {
    const { serviceManager } =
        InjectionExtractor.extractUserFromInjected(res).user
    const { appName, receipt } = req.params
    try {
        if (!/^[a-f0-9-]{32,36}$/.test(receipt)) {
            throw ApiStatusCodes.createError(
                ApiStatusCodes.ILLEGAL_OPERATION,
                'Invalid candidate build receipt'
            )
        }
        const stopped = await serviceManager.stopCandidateBuild(
            appName,
            receipt
        )
        const reply = new BaseApi(
            ApiStatusCodes.STATUS_OK,
            'Candidate build stop status'
        )
        reply.data = { stopped }
        res.send(reply)
    } catch (error) {
        ApiStatusCodes.createCatcher(res)(error)
    }
})

router.post<{ appName: string; receipt: string }>(
    '/:appName/builds/:receipt',
    upload.single('sourceFile'),
    async function (req, res) {
        const { dataStore, serviceManager } =
            InjectionExtractor.extractUserFromInjected(res).user
        const { appName, receipt } = req.params
        const file = req.file?.path
        let queued = false
        try {
            const app = await dataStore
                .getAppsDataStore()
                .getAppDefinition(appName)
            const existing = app.versions.find(
                (version) => version.preparedBuild?.receipt === receipt
            )?.preparedBuild
            if (
                existing?.image ||
                existing?.error ||
                serviceManager.candidateBuildState(appName, receipt) ||
                serviceManager.isCandidateBuildStopping(appName, receipt)
            ) {
                res.send(
                    new BaseApi(
                        ApiStatusCodes.STATUS_OK_DEPLOY_STARTED,
                        'Candidate build already recorded'
                    )
                )
                return
            }
            if (serviceManager.isAppBuilding(appName)) {
                throw ApiStatusCodes.createError(
                    ApiStatusCodes.ILLEGAL_OPERATION,
                    'An application build is already in progress'
                )
            }
            await uploadCaptainDefinitionContentHandler(
                {
                    appName,
                    isDetachedBuild: true,
                    uploadedTarPathSource: file,
                    buildReceipt: receipt,
                    buildArgs: parseCandidateBuildArgs(req.body?.buildArgs),
                },
                serviceManager
            )
            queued = true
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK_DEPLOY_STARTED,
                    'Candidate build scheduled without deployment'
                )
            )
        } catch (error) {
            ApiStatusCodes.createCatcher(res)(error)
        } finally {
            if (file && !queued) await fs.remove(file).catch(() => {})
        }
    }
)

router.post('/:appName/', function (req, res, next) {
    const dataStore =
        InjectionExtractor.extractUserFromInjected(res).user.dataStore
    const appName = req.params.appName

    return dataStore
        .getAppsDataStore()
        .getAppDefinition(appName)
        .then(function (app) {
            // nothing to do with app, just to make sure that it exists!
            next()
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

// uploadCaptainDefinitionContent
router.post<{ appName: string }>(
    '/:appName/',
    upload.single('sourceFile'),
    function (req, res, next) {
        const serviceManager =
            InjectionExtractor.extractUserFromInjected(res).user.serviceManager

        const appName = req.params.appName
        const isDetachedBuild = !!req.query.detached
        const captainDefinitionContent = `${req.body.captainDefinitionContent || ''}`
        const gitHash = `${req.body.gitHash || ''}`
        const tarballSourceFilePath: string = req.file ? req.file.path : ''

        return uploadCaptainDefinitionContentHandler(
            {
                appName,
                isDetachedBuild,
                captainDefinitionContent: captainDefinitionContent || undefined,
                gitHash: gitHash || undefined,
                uploadedTarPathSource: tarballSourceFilePath || undefined,
            },
            serviceManager
        )
            .then(function (result) {
                const status = isDetachedBuild
                    ? ApiStatusCodes.STATUS_OK_DEPLOY_STARTED
                    : ApiStatusCodes.STATUS_OK
                res.send(new BaseApi(status, result.message))
            })
            .catch(ApiStatusCodes.createCatcher(res))
    }
)

export default router

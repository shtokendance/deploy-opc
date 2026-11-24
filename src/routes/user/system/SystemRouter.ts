import express = require('express')
import fs from 'fs/promises'
import path from 'path'
import validator from 'validator'
import ApiStatusCodes from '../../../api/ApiStatusCodes'
import BaseApi from '../../../api/BaseApi'
import DockerApi from '../../../docker/DockerApi'
import DockerUtils from '../../../docker/DockerUtils'
import InjectionExtractor from '../../../injection/InjectionExtractor'
import { IAppDef } from '../../../models/AppDefinition'
import { AutomatedCleanupConfigsCleaner } from '../../../models/AutomatedCleanupConfigs'
import {
    inspectApplicationVolumePaths,
    listApplicationVolumeRoots,
    prepareApplicationVolumePath,
    removeLocalApplicationVolumeDirectory,
    streamApplicationVolumesTarGz,
} from '../../../user/system/ApplicationVolumePaths'
import CaptainManager from '../../../user/system/CaptainManager'
import VersionManager from '../../../user/system/VersionManager'
import CaptainConstants from '../../../utils/CaptainConstants'
import Logger from '../../../utils/Logger'
import Utils from '../../../utils/Utils'
import ThemesRouter from './ThemesRouter'
import SystemRouteSelfHostRegistry from './selfhostregistry/SystemRouteSelfHostRegistry'

const router = express.Router()

router.use('/selfhostregistry/', SystemRouteSelfHostRegistry)
router.use('/themes/', ThemesRouter)

router.post('/createbackup/', function (req, res, next) {
    const backupManager = CaptainManager.get().getBackupManager()

    Promise.resolve()
        .then(function () {
            return backupManager.createBackup(CaptainManager.get())
        })
        .then(function (backupInfo) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Backup created.'
            )
            baseApi.data = backupInfo
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/changerootdomain/', function (req, res, next) {
    const requestedCustomDomain = Utils.removeHttpHttps(
        (req.body.rootDomain || '').toLowerCase()
    )

    if (
        !requestedCustomDomain ||
        requestedCustomDomain.length < 3 ||
        requestedCustomDomain.indexOf('/') >= 0 ||
        requestedCustomDomain.indexOf(':') >= 0 ||
        requestedCustomDomain.indexOf('%') >= 0 ||
        requestedCustomDomain.indexOf(' ') >= 0 ||
        requestedCustomDomain.indexOf('\\') >= 0
    ) {
        res.send(
            new BaseApi(ApiStatusCodes.STATUS_ERROR_GENERIC, 'Bad domain name.')
        )
        return
    }

    CaptainManager.get()
        .changeCaptainRootDomain(requestedCustomDomain, !!req.body.force)
        .then(function () {
            res.send(
                new BaseApi(ApiStatusCodes.STATUS_OK, 'Root domain changed.')
            )
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/enablessl/', function (req, res, next) {
    const emailAddress = req.body.emailAddress || ''

    if (
        !emailAddress ||
        emailAddress.length < 3 ||
        emailAddress.indexOf('/') >= 0 ||
        emailAddress.indexOf(':') >= 0 ||
        emailAddress.indexOf('%') >= 0 ||
        emailAddress.indexOf(' ') >= 0 ||
        emailAddress.indexOf('\\') >= 0 ||
        !validator.isEmail(emailAddress)
    ) {
        res.send(
            new BaseApi(
                ApiStatusCodes.STATUS_ERROR_GENERIC,
                'Bad email address.'
            )
        )
        return
    }

    CaptainManager.get()
        .enableSsl(emailAddress)
        .then(function () {
            // This is necessary as the CLI immediately tries to connect to https://captain.root.com
            // Without this delay it'll fail to connect
            Logger.d('Waiting for 7 seconds...')
            return Utils.getDelayedPromise(7000)
        })
        .then(function () {
            res.send(new BaseApi(ApiStatusCodes.STATUS_OK, 'Root SSL Enabled.'))
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/forcessl/', function (req, res, next) {
    const isEnabled = !!req.body.isEnabled

    CaptainManager.get()
        .forceSsl(isEnabled)
        .then(function () {
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK,
                    `Non-SSL traffic is now ${
                        isEnabled ? 'rejected.' : 'allowed.'
                    }`
                )
            )
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/info/', function (req, res, next) {
    const dataStore =
        InjectionExtractor.extractUserFromInjected(res).user.dataStore

    return Promise.resolve()
        .then(function () {
            return dataStore.getHasRootSsl()
        })
        .then(function (hasRootSsl) {
            return {
                hasRootSsl: hasRootSsl,
                forceSsl: CaptainManager.get().getForceSslValue(),
                rootDomain: dataStore.hasCustomDomain()
                    ? dataStore.getRootDomain()
                    : '',
                captainSubDomain: CaptainConstants.configs.captainSubDomain,
            }
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Captain info retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/loadbalancerinfo/', function (req, res, next) {
    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().getLoadBalanceManager().getInfo()
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Load Balancer info retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/versionInfo/', function (req, res, next) {
    return Promise.resolve()
        .then(function () {
            return VersionManager.get().getCaptainImageTags()
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Version Info Retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/versionInfo/', function (req, res, next) {
    const latestVersion = req.body.latestVersion
    const registryHelper =
        InjectionExtractor.extractUserFromInjected(
            res
        ).user.serviceManager.getRegistryHelper()

    return Promise.resolve()
        .then(function () {
            return VersionManager.get().updateCaptain(
                latestVersion,
                registryHelper
            )
        })
        .then(function () {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Captain update process has started...'
            )
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/application-storage/', function (req, res, next) {
    const docker = DockerApi.get()
    const captain = CaptainManager.get()

    Promise.all([
        captain.getDiskUsage(),
        docker.getVolumeUsage(),
        docker.getAllServices(true),
        docker
            .getServiceMounts(CaptainConstants.captainServiceName)
            .catch(() => []),
    ])
        .then(async function ([disk, volumes, services, serviceMounts]) {
            let nodeId = disk?.nodes?.[0]?.nodeId || ''
            if (!nodeId) {
                try {
                    nodeId = captain.getMyNodeId()
                } catch {
                    nodeId = ''
                }
            }
            const volumeRoots = await listApplicationVolumeRoots(
                nodeId,
                serviceMounts
            )
            const response = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Application storage retrieved'
            )
            response.data = {
                disk,
                volumes,
                volume_roots: volumeRoots,
                services: services.map(({ Spec, ServiceStatus }) => ({
                    name: Spec.Name,
                    running_tasks: ServiceStatus?.RunningTasks ?? 0,
                    mounts: (Spec.TaskTemplate.ContainerSpec?.Mounts || [])
                        .filter(
                            (mount) =>
                                mount.Type === 'volume' || mount.Type === 'bind'
                        )
                        .map((mount) => ({
                            type: mount.Type,
                            source: mount.Source,
                            target: mount.Target,
                        })),
                })),
            }
            res.send(response)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/application-storage/paths/:appName', function (req, res) {
    const appName = req.params.appName
    const apps =
        InjectionExtractor.extractUserFromInjected(
            res
        ).user.dataStore.getAppsDataStore()
    apps.getAppDefinition(appName)
        .then(function (app) {
            return DockerApi.get().getRunningApplicationBinds(
                apps.getServiceName(appName, !!app.isLegacyAppName),
                CaptainManager.get().getMyNodeId()
            )
        })
        .then(function (tasks) {
            const response = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Application bind mounts retrieved'
            )
            response.data = tasks
            res.send(response)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/application-storage/paths/', function (req, res) {
    const { root, backend, node_id, directory, create } = req.body || {}
    if (
        typeof root !== 'string' ||
        root.length > 255 ||
        (backend !== 'local-directory' && backend !== 'aliyun-oss-volume') ||
        typeof node_id !== 'string' ||
        typeof directory !== 'string' ||
        typeof create !== 'boolean' ||
        (create && !directory)
    ) {
        res.send(
            new BaseApi(
                ApiStatusCodes.STATUS_ERROR_GENERIC,
                'Invalid storage path request'
            )
        )
        return
    }
    Promise.resolve()
        .then(function () {
            if (node_id !== CaptainManager.get().getMyNodeId()) {
                throw new Error(
                    'Storage node does not match the active Deploy node'
                )
            }
            return DockerApi.get().getServiceMounts(
                CaptainConstants.captainServiceName
            )
        })
        .then(function (mounts) {
            return prepareApplicationVolumePath(
                root,
                backend,
                directory,
                create,
                mounts
            )
        })
        .then(function () {
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK,
                    'Application storage path ready'
                )
            )
        })
        .catch(function (error: Error) {
            const message =
                'code' in error
                    ? 'Storage path is missing or inaccessible on the Deploy node'
                    : error.message
            res.send(new BaseApi(ApiStatusCodes.STATUS_ERROR_GENERIC, message))
        })
})

router.delete('/application-storage/paths/', function (req, res, next) {
    const { root, node_id, directory } = req.body || {}
    if (
        typeof root !== 'string' ||
        root.length > 255 ||
        typeof node_id !== 'string' ||
        typeof directory !== 'string'
    ) {
        res.send(
            new BaseApi(
                ApiStatusCodes.STATUS_ERROR_GENERIC,
                'Invalid storage path request'
            )
        )
        return
    }
    const docker = DockerApi.get()
    Promise.resolve()
        .then(async function () {
            if (node_id !== CaptainManager.get().getMyNodeId()) {
                throw new Error(
                    'Storage node does not match the active Deploy node'
                )
            }
            const mounts = await docker.getServiceMounts(
                CaptainConstants.captainServiceName
            )
            await removeLocalApplicationVolumeDirectory(
                root,
                directory,
                mounts,
                () => docker.getApplicationStorageBindSources(root)
            )
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_OK,
                    'Application storage removed'
                )
            )
        })
        .catch(function (error: unknown) {
            const message =
                error instanceof Error && !('code' in error)
                    ? error.message
                    : 'Storage path is inaccessible on the Deploy node'
            res.send(new BaseApi(ApiStatusCodes.STATUS_ERROR_GENERIC, message))
        })
})

router.get('/diskusage/', function (req, res, next) {
    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().getDiskUsage()
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Disk usage retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(function (error) {
            Logger.e(error, 'Unable to retrieve disk usage')
            res.send(
                new BaseApi(
                    ApiStatusCodes.STATUS_ERROR_GENERIC,
                    'Unable to retrieve disk usage'
                )
            )
        })
})

router.get('/diskcleanup/', function (req, res, next) {
    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().getDiskCleanupManager().getConfigs()
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Disk cleanup configs retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/diskcleanup/', function (req, res, next) {
    return Promise.resolve()
        .then(function () {
            const configs = AutomatedCleanupConfigsCleaner.sanitizeInput({
                mostRecentLimit: req.body.mostRecentLimit,
                cronSchedule: req.body.cronSchedule,
                timezone: req.body.timezone,
            })
            return CaptainManager.get()
                .getDiskCleanupManager()
                .setConfig(configs)
        })
        .then(function () {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Disk cleanup configs updated'
            )
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/netdata/', function (req, res, next) {
    const dataStore =
        InjectionExtractor.extractUserFromInjected(res).user.dataStore

    return Promise.resolve()
        .then(function () {
            return dataStore.getNetDataInfo()
        })
        .then(function (data) {
            data.netDataUrl = `${
                CaptainConstants.configs.captainSubDomain
            }.${dataStore.getRootDomain()}${
                CaptainConstants.netDataRelativePath
            }`
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Netdata info retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/netdata/', function (req, res, next) {
    const netDataInfo = req.body.netDataInfo
    netDataInfo.netDataUrl = undefined // Frontend app returns this value, but we really don't wanna save this.
    // root address is subject to change.

    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().updateNetDataInfo(netDataInfo)
        })
        .then(function () {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Netdata info is updated'
            )
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/goaccess/', function (req, res, next) {
    const dataStore =
        InjectionExtractor.extractUserFromInjected(res).user.dataStore

    return Promise.resolve()
        .then(function () {
            return dataStore.getGoAccessInfo()
        })
        .then(function (goAccessInfo) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'GoAccess info retrieved'
            )
            baseApi.data = goAccessInfo
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/goaccess/', function (req, res, next) {
    const goAccessInfo = req.body.goAccessInfo

    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().updateGoAccessInfo(goAccessInfo)
        })
        .then(function () {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'GoAccess info is updated'
            )
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/goaccess/:appName/files', async function (req, res, next) {
    const dataStore =
        InjectionExtractor.extractUserFromInjected(res).user.dataStore

    const goAccessInfo = await dataStore.getGoAccessInfo()
    const loadBalanceManager = CaptainManager.get().getLoadBalanceManager()

    const appName = req.params.appName

    if (!appName) {
        const baseApi = new BaseApi(
            ApiStatusCodes.STATUS_ERROR_GENERIC,
            'Invalid appName'
        )
        baseApi.data = []
        res.send(baseApi)
        return
    }

    if (!goAccessInfo.isEnabled) {
        const baseApi = new BaseApi(
            ApiStatusCodes.STATUS_ERROR_GENERIC,
            'GoAccess not enabled'
        )
        baseApi.data = []
        res.send(baseApi)
        return
    }

    const directoryPath = path.join(
        CaptainConstants.nginxSharedLogsPathOnHost,
        appName
    )

    let appDefinition: IAppDef | undefined = undefined

    return Promise.resolve()
        .then(function () {
            // Ensure a valid appName parameter
            return dataStore.getAppsDataStore().getAppDefinition(appName)
        })
        .then(function (data) {
            appDefinition = data
            return fs.readdir(directoryPath).catch((e) => {
                Logger.d('No goaccess logs found')
                return []
            })
        })
        .then(function (files) {
            return Promise.all(
                files
                    // Make sure to only return the generated reports and not folders or the live report
                    // That will be added back later
                    .filter(
                        (f) => f.endsWith('.html') && !f.endsWith('Live.html')
                    )
                    .map((file) => {
                        return fs
                            .stat(path.join(directoryPath, file))
                            .then(function (fileStats) {
                                return {
                                    name: file,
                                    time: fileStats.mtime,
                                }
                            })
                    })
            )
        })
        .then(function (linkData) {
            const baseUrl = `/user/system/goaccess/`

            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'GoAccess info retrieved'
            )
            const linkList = linkData.map((d) => {
                const { domainName, fileName } =
                    loadBalanceManager.parseLogPath(d.name)
                return {
                    domainName,
                    name: fileName,
                    lastModifiedTime: d.time,
                    url: baseUrl + `${appName}/files/${d.name}`,
                }
            })

            // Add in the live report for all sites even if it might not exist yet since they're dynamic
            const allDomains = [
                `${appName}.${dataStore.getRootDomain()}`,
                ...appDefinition!.customDomain.map((d) => d.publicDomain),
            ]
            for (const domain of allDomains) {
                const name =
                    loadBalanceManager.getLogName(appName, domain) +
                    '--Live.html'
                linkList.push({
                    domainName: domain,
                    name,
                    lastModifiedTime: new Date(),
                    url: baseUrl + `${appName}/files/${name}`,
                })
            }

            linkList.sort(
                (a, b) =>
                    b.lastModifiedTime.getTime() - a.lastModifiedTime.getTime()
            )

            baseApi.data = linkList

            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/goaccess/:appName/files/:file', async function (req, res, next) {
    const { appName, file } = req.params
    const { domainName, fileName } = CaptainManager.get()
        .getLoadBalanceManager()
        .parseLogPath(file)
    if (fileName.includes('Live')) {
        // Dynamically update the live reports by running the catchup script for the particular domain
        await DockerApi.get().createContainer({
            imageName: CaptainConstants.configs.goAccessImageName,
            command: ['./catchupLog.sh'],
            volumes: [
                {
                    hostPath: CaptainConstants.nginxSharedLogsPathOnHost,
                    containerPath: CaptainConstants.nginxSharedLogsPath,
                    mode: 'rw',
                },
            ],
            network: CaptainConstants.captainNetworkName,
            arrayOfEnvKeyAndValue: [
                {
                    key: 'FILE_PREFIX',
                    value: `${appName}--${domainName}`,
                },
                {
                    key: 'ANONYMIZE_IP',
                    value: CaptainConstants.configs.goAccessAnonymizeIP.toString(),
                },
            ],
            sticky: false,
            wait: true,
        })
    }

    const fileRelativePath = `${appName}/${file}`
    const absolutePath = path.join(
        CaptainConstants.nginxSharedLogsPathOnHost,
        appName,
        file
    )

    return Promise.resolve()
        .then(function () {
            return fs.readFile(absolutePath, 'utf8')
        })
        .then(function (fileContents) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'GoAccess report retrieved'
            )
            baseApi.data = fileContents
            res.send(baseApi)
        })
        .catch(function (error) {
            Logger.e(error, 'Error getting GoAccess report ' + fileRelativePath)
            const baseApi = new BaseApi(
                ApiStatusCodes.NOT_FOUND,
                'Report not found'
            )
            res.send(baseApi)
        })
})

router.get('/nginxconfig/', function (req, res, next) {
    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().getNginxConfig()
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Nginx config retrieved'
            )
            baseApi.data = data
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/nginxconfig/', function (req, res, next) {
    const baseConfigCustomValue = req.body.baseConfig.customValue
    const captainConfigCustomValue = req.body.captainConfig.customValue

    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().setNginxConfig(
                baseConfigCustomValue,
                captainConfigCustomValue
            )
        })
        .then(function () {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Nginx config is updated'
            )
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.get('/nodes/', function (req, res, next) {
    return Promise.resolve()
        .then(function () {
            return CaptainManager.get().getNodesInfo()
        })
        .then(function (data) {
            const baseApi = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Node info retrieved'
            )
            baseApi.data = { nodes: data }
            res.send(baseApi)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/nodes/', function (req, res, next) {
    const MANAGER = 'manager'
    const WORKER = 'worker'
    const registryHelper =
        InjectionExtractor.extractUserFromInjected(
            res
        ).user.serviceManager.getRegistryHelper()

    let isManager: boolean

    if (req.body.nodeType === MANAGER) {
        isManager = true
    } else if (req.body.nodeType === WORKER) {
        isManager = false
    } else {
        res.send(
            new BaseApi(
                ApiStatusCodes.STATUS_ERROR_GENERIC,
                'Node type should be either manager or worker'
            )
        )
        return
    }

    const privateKey = req.body.privateKey
    const remoteNodeIpAddress = req.body.remoteNodeIpAddress
    const captainIpAddress = req.body.captainIpAddress
    const sshPort = parseInt(req.body.sshPort) || 22
    const sshUser = (req.body.sshUser || 'root').trim()

    if (!captainIpAddress || !remoteNodeIpAddress || !privateKey) {
        res.send(
            new BaseApi(
                ApiStatusCodes.STATUS_ERROR_GENERIC,
                'Private Key, Captain IP address, remote IP address and remote username should all be present'
            )
        )
        return
    }

    return Promise.resolve()
        .then(function () {
            return registryHelper.getDefaultPushRegistryId()
        })
        .then(function (defaultRegistry) {
            if (!defaultRegistry) {
                throw ApiStatusCodes.createError(
                    ApiStatusCodes.STATUS_ERROR_GENERIC,
                    'There is no default Docker Registry. You need a repository for your images before adding nodes. Read docs.'
                )
            }
        })
        .then(function () {
            return DockerUtils.joinDockerNode(
                DockerApi.get(),
                sshUser,
                sshPort,
                captainIpAddress,
                isManager,
                remoteNodeIpAddress,
                privateKey
            )
        })
        .then(function () {
            const msg = 'Docker node is successfully joined.'
            Logger.d(msg)
            res.send(new BaseApi(ApiStatusCodes.STATUS_OK, msg))
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/application-storage/inspect/', function (req, res) {
    const { node_id, paths } = req.body || {}
    if (
        typeof node_id !== 'string' ||
        !Array.isArray(paths) ||
        paths.some((p) => typeof p !== 'string')
    ) {
        res.send(
            new BaseApi(
                ApiStatusCodes.STATUS_ERROR_GENERIC,
                'Invalid storage inspect request'
            )
        )
        return
    }
    Promise.resolve()
        .then(async function () {
            if (node_id !== CaptainManager.get().getMyNodeId()) {
                throw new Error(
                    'Storage node does not match the active Deploy node'
                )
            }
            const serviceMounts = await DockerApi.get().getServiceMounts(
                CaptainConstants.captainServiceName
            )
            const stats = await inspectApplicationVolumePaths(
                paths,
                serviceMounts
            )
            const response = new BaseApi(
                ApiStatusCodes.STATUS_OK,
                'Application volume paths inspected'
            )
            response.data = { paths: stats }
            res.send(response)
        })
        .catch(ApiStatusCodes.createCatcher(res))
})

router.post('/application-storage/export/', function (req, res) {
    const { node_id, app_slug, app_name, mounts, max_bytes } = req.body || {}
    if (
        typeof node_id !== 'string' ||
        typeof app_slug !== 'string' ||
        !app_slug.trim() ||
        !Array.isArray(mounts) ||
        mounts.length === 0
    ) {
        res.status(400).send(
            new BaseApi(
                ApiStatusCodes.STATUS_ERROR_GENERIC,
                'Invalid storage export request'
            )
        )
        return
    }
    Promise.resolve()
        .then(async function () {
            if (node_id !== CaptainManager.get().getMyNodeId()) {
                throw new Error(
                    'Storage node does not match the active Deploy node'
                )
            }
            const serviceMounts = await DockerApi.get().getServiceMounts(
                CaptainConstants.captainServiceName
            )
            res.setHeader('Content-Type', 'application/gzip')
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${app_slug.trim()}-volumes.tar.gz"`
            )
            await streamApplicationVolumesTarGz(
                {
                    app_slug: app_slug.trim(),
                    app_name:
                        typeof app_name === 'string'
                            ? app_name.trim()
                            : undefined,
                    mounts,
                    max_bytes:
                        typeof max_bytes === 'number' ? max_bytes : undefined,
                },
                serviceMounts,
                res
            )
        })
        .catch(function (err: Error) {
            if (!res.headersSent) {
                res.status(400).send(
                    new BaseApi(ApiStatusCodes.STATUS_ERROR_GENERIC, err.message)
                )
            } else {
                res.destroy(err)
            }
        })
})

export default router

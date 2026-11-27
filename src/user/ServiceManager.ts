import fs = require('fs-extra')
import ApiStatusCodes from '../api/ApiStatusCodes'
import DataStore from '../datastore/DataStore'
import DockerApi, { IDockerUpdateOrders } from '../docker/DockerApi'
import { CandidateRequest, CandidateSandbox } from '../docker/DeliveryCandidate'
import {
    AppDeployTokenConfig,
    IAppDef,
    IAppEnvVar,
    IAppPort,
    IAppTag,
    IAppVolume,
    IHttpAuth,
    RepoInfo,
} from '../models/AppDefinition'
import { DockerAuthObj } from '../models/DockerAuthObj'
import { AppRuntimeDetails, AppsRuntimeResponse } from '../models/AppRuntime'
import { IHashMapGeneric } from '../models/ICacheGeneric'
import { IImageSource } from '../models/IImageSource'
import { PreDeployFunction } from '../models/OtherTypes'
import CaptainConstants from '../utils/CaptainConstants'
import Logger from '../utils/Logger'
import Utils from '../utils/Utils'
import Authenticator from './Authenticator'
import DockerRegistryHelper from './DockerRegistryHelper'
import ImageMaker, { BuildLogsManager } from './ImageMaker'
import { EventLogger } from './events/EventLogger'
import {
    CapRoverEventFactory,
    CapRoverEventType,
} from './events/ICapRoverEvent'
import DomainResolveChecker from './system/DomainResolveChecker'
import LoadBalancerManager from './system/LoadBalancerManager'
import requireFromString = require('require-from-string')

const ERROR_FIRST_ENABLE_ROOT_SSL =
    'You have to first enable SSL for your root domain'

const serviceMangerCache = {} as IHashMapGeneric<ServiceManager>

interface QueuedPromise {
    resolve: undefined | ((reason?: unknown) => void)
    reject: undefined | ((reason?: any) => void)
    promise: undefined | Promise<unknown>
}

interface QueuedBuild {
    appName: string
    source: IImageSource
    promiseToSave: QueuedPromise
}

class ServiceManager {
    static get(
        namespace: string,
        authenticator: Authenticator,
        dataStore: DataStore,
        dockerApi: DockerApi,
        loadBalancerManager: LoadBalancerManager,
        eventLogger: EventLogger,
        domainResolveChecker: DomainResolveChecker
    ) {
        if (!serviceMangerCache[namespace]) {
            serviceMangerCache[namespace] = new ServiceManager(
                dataStore,
                authenticator,
                dockerApi,
                loadBalancerManager,
                eventLogger,
                domainResolveChecker
            )
        }
        return serviceMangerCache[namespace]
    }

    private activeOrScheduledBuilds: IHashMapGeneric<boolean>
    private readonly activeCandidateBuilds = new Map<string, string>()
    private readonly candidateBuildControllers = new Map<
        string,
        AbortController
    >()
    private readonly candidateStops = new Set<string>()
    private readonly stoppedBuildUploads = new Map<string, string>()
    private pendingPreStagedDefinitions: IHashMapGeneric<IAppDef>
    private buildLogsManager: BuildLogsManager
    private queuedBuilds: QueuedBuild[]
    private isReady: boolean
    private imageMaker: ImageMaker
    private dockerRegistryHelper: DockerRegistryHelper

    constructor(
        private dataStore: DataStore,
        private authenticator: Authenticator,
        private dockerApi: DockerApi,
        private loadBalancerManager: LoadBalancerManager,
        private eventLogger: EventLogger,
        private domainResolveChecker: DomainResolveChecker
    ) {
        this.activeOrScheduledBuilds = {}
        this.pendingPreStagedDefinitions = {}
        this.queuedBuilds = []
        this.buildLogsManager = new BuildLogsManager()
        this.isReady = true
        this.dockerRegistryHelper = new DockerRegistryHelper(
            this.dataStore,
            this.dockerApi
        )
        this.imageMaker = new ImageMaker(
            this.dockerRegistryHelper,
            this.dockerApi,
            this.dataStore.getNameSpace(),
            this.buildLogsManager
        )
    }

    getRegistryHelper() {
        return this.dockerRegistryHelper
    }

    isInited() {
        return this.isReady
    }

    scheduleDeployNewVersion(appName: string, source: IImageSource) {
        const self = this

        const activeBuildAppName = self.isAnyBuildRunning()
        this.activeOrScheduledBuilds[appName] = true

        if (!activeBuildAppName) {
            self.buildLogsManager.getAppBuildLogs(appName).clear()
        }

        if (activeBuildAppName) {
            const existingBuildForTheSameApp = self.queuedBuilds.find(
                (v) => v.appName === appName
            )

            if (existingBuildForTheSameApp) {
                self.buildLogsManager
                    .getAppBuildLogs(appName)
                    .log(
                        `A build for ${appName} was queued, it's now being replaced with a new build...`
                    )

                const prevTarPath =
                    existingBuildForTheSameApp.source.uploadedTarPathSource
                        ?.uploadedTarPath
                const nextTarPath =
                    source.uploadedTarPathSource?.uploadedTarPath
                if (prevTarPath && prevTarPath !== nextTarPath) {
                    fs.remove(prevTarPath).catch(function () {
                        // best effort cleanup of superseded upload
                    })
                }

                // replacing the new source!
                existingBuildForTheSameApp.source = source

                const existingPromise =
                    existingBuildForTheSameApp.promiseToSave.promise

                if (!existingPromise)
                    throw new Error(
                        'Existing promise for the queued app is NULL!!'
                    )

                return existingPromise
            }

            self.buildLogsManager
                .getAppBuildLogs(appName)
                .log(
                    `An active build (${activeBuildAppName}) is in progress. This build is queued...`
                )

            const promiseToSave: QueuedPromise = {
                resolve: undefined,
                reject: undefined,
                promise: undefined,
            }

            const promise = new Promise(function (resolve, reject) {
                promiseToSave.resolve = resolve
                promiseToSave.reject = reject
            })

            promiseToSave.promise = promise

            self.queuedBuilds.push({ appName, source, promiseToSave })

            // This should only return when the build is finished,
            // somehow we need save the promise in queue - for "attached builds"
            return promise
        }

        return this.startDeployingNewVersion(appName, source)
    }

    startDeployingNewVersion(appName: string, source: IImageSource) {
        const self = this
        const dataStore = this.dataStore
        let deployedVersion: number
        let hasAdvancedBuildQueue = false

        self.activeOrScheduledBuilds[appName] = true
        self.buildLogsManager.getAppBuildLogs(appName).clear()
        if (source.buildReceipt) {
            self.activeCandidateBuilds.set(appName, source.buildReceipt)
        }
        const cancellation = source.buildReceipt
            ? new AbortController()
            : undefined
        if (cancellation)
            self.candidateBuildControllers.set(appName, cancellation)

        function advanceBuildQueueOnce() {
            if (hasAdvancedBuildQueue) {
                return
            }

            hasAdvancedBuildQueue = true
            self.onBuildFinished(appName)
        }

        return Promise.resolve() //
            .then(function () {
                return dataStore
                    .getAppsDataStore()
                    .createNewVersion(appName, source.buildReceipt)
            })
            .then(function (appVersion) {
                deployedVersion = appVersion
                return dataStore
                    .getAppsDataStore()
                    .getAppDefinition(appName)
                    .then(function (app) {
                        const envVars = source.buildReceipt
                            ? (source.buildArgs ?? [])
                            : app.envVars || []

                        return self.imageMaker.ensureImage(
                            source,
                            appName,
                            app.captainDefinitionRelativeFilePath,
                            appVersion,
                            envVars,
                            cancellation?.signal
                        )
                    })
            })
            .then(function (builtImage) {
                cancellation?.signal.throwIfAborted()
                if (source.buildReceipt) {
                    return dataStore
                        .getAppsDataStore()
                        .savePreparedBuild(appName, deployedVersion, {
                            image: builtImage.imageName,
                            log: self.buildLogTail(appName),
                        })
                }
                return dataStore
                    .getAppsDataStore()
                    .setDeployedVersionAndImage(
                        appName,
                        deployedVersion,
                        builtImage
                    )
            })
            .then(function () {
                if (source.buildReceipt) return
                self.eventLogger.trackEvent(
                    CapRoverEventFactory.create(
                        CapRoverEventType.AppBuildSuccessful,
                        {
                            appName,
                        }
                    )
                )

                return self.ensureServiceInitedAndUpdated(appName)
            })
            .then(function () {
                if (!source.buildReceipt)
                    delete self.pendingPreStagedDefinitions[appName]
                advanceBuildQueueOnce()
            })
            .catch(function (error) {
                if (source.buildReceipt) {
                    self.logBuildFailed(appName, error)
                    const record =
                        deployedVersion === undefined
                            ? Promise.resolve()
                            : dataStore
                                  .getAppsDataStore()
                                  .savePreparedBuild(appName, deployedVersion, {
                                      error: cancellation?.signal.aborted
                                          ? 'Candidate image build cancelled'
                                          : 'Candidate image build failed',
                                      log: self.buildLogTail(appName),
                                  })
                    return record
                        .finally(advanceBuildQueueOnce)
                        .then(function () {
                            return Promise.reject(error)
                        })
                }
                const preStagedOld = self.pendingPreStagedDefinitions[appName]
                delete self.pendingPreStagedDefinitions[appName]
                const rollbackPreStaged = preStagedOld
                    ? self
                          .restoreAppDefinition(appName, preStagedOld)
                          .catch(function (restoreErr) {
                              Logger.w(
                                  `Failed to restore pre-staged definition for ${appName}: ${restoreErr}`
                              )
                          })
                    : Promise.resolve()

                return rollbackPreStaged.then(function () {
                    self.logBuildFailed(appName, error)
                    advanceBuildQueueOnce()
                    return Promise.reject(error)
                })
            })
    }

    onBuildFinished(appName: string) {
        const self = this
        self.activeCandidateBuilds.delete(appName)
        self.candidateBuildControllers.delete(appName)
        self.activeOrScheduledBuilds[appName] = false

        Promise.resolve().then(function () {
            const newBuild = self.queuedBuilds.shift()
            if (newBuild)
                self.startDeployingNewVersion(
                    newBuild.appName,
                    newBuild.source
                ).then(
                    newBuild.promiseToSave.resolve,
                    newBuild.promiseToSave.reject
                )
        })
    }

    enableCustomDomainSsl(appName: string, customDomain: string) {
        const self = this

        return Promise.resolve()
            .then(function () {
                return self.dataStore.getHasRootSsl()
            })
            .then(function (rootHasSsl) {
                if (!rootHasSsl) {
                    throw ApiStatusCodes.createError(
                        ApiStatusCodes.STATUS_ERROR_GENERIC,
                        ERROR_FIRST_ENABLE_ROOT_SSL
                    )
                }

                Logger.d(`Verifying Captain owns domain: ${customDomain}`)

                return self.domainResolveChecker.verifyCaptainOwnsDomainOrThrow(
                    customDomain,
                    undefined
                )
            })
            .then(function () {
                Logger.d(`Enabling SSL for: ${appName} on ${customDomain}`)

                return self.dataStore
                    .getAppsDataStore()
                    .verifyCustomDomainBelongsToApp(appName, customDomain)
            })
            .then(function () {
                return self.domainResolveChecker.requestCertificateForDomain(
                    customDomain
                )
            })
            .then(function () {
                return self.dataStore
                    .getAppsDataStore()
                    .enableCustomDomainSsl(appName, customDomain)
            })
            .then(function () {
                return self.reloadLoadBalancer()
            })
    }

    addCustomDomain(appName: string, customDomain: string) {
        const self = this

        return Promise.resolve()
            .then(function () {
                return self.dataStore
                    .getAppsDataStore()
                    .ensureCustomDomainIsAvailable(appName, customDomain)
            })
            .then(function () {
                const rootDomain = self.dataStore.getRootDomain()

                try {
                    Utils.checkCustomDomain(customDomain, appName, rootDomain)
                } catch (error) {
                    throw ApiStatusCodes.createError(
                        ApiStatusCodes.STATUS_ERROR_BAD_NAME,
                        error
                    )
                }
            })
            .then(function () {
                return self.domainResolveChecker.verifyDomainResolvesToDefaultServerOnHost(
                    customDomain
                )
            })
            .then(function () {
                Logger.d(`Enabling custom domain for: ${appName}`)

                return self.dataStore
                    .getAppsDataStore()
                    .addCustomDomainForApp(appName, customDomain)
            })
            .then(function () {
                return self.reloadLoadBalancer()
            })
    }

    removeCustomDomain(appName: string, customDomain: string) {
        const self = this

        return Promise.resolve()
            .then(function () {
                Logger.d(`Removing custom domain for: ${appName}`)

                return self.dataStore
                    .getAppsDataStore()
                    .removeCustomDomainForApp(appName, customDomain)
            })
            .then(function () {
                return self.reloadLoadBalancer()
            })
    }

    enableSslForApp(appName: string) {
        const self = this

        let rootDomain: string

        return Promise.resolve()
            .then(function () {
                return self.dataStore.getHasRootSsl()
            })
            .then(function (rootHasSsl) {
                if (!rootHasSsl) {
                    throw ApiStatusCodes.createError(
                        ApiStatusCodes.STATUS_ERROR_GENERIC,
                        ERROR_FIRST_ENABLE_ROOT_SSL
                    )
                }
                return self.verifyCaptainOwnsGenericSubDomain(appName)
            })
            .then(function () {
                Logger.d(`Enabling SSL for: ${appName}`)

                return self.dataStore.getRootDomain()
            })
            .then(function (val) {
                rootDomain = val

                if (!rootDomain) {
                    throw new Error('No rootDomain! Cannot verify domain')
                }
            })
            .then(function () {
                // it will ensure that the app exists, otherwise it throws an exception
                return self.dataStore
                    .getAppsDataStore()
                    .getAppDefinition(appName)
            })
            .then(function () {
                return `${appName}.${rootDomain}`
            })
            .then(function (domainName) {
                return self.domainResolveChecker.requestCertificateForDomain(
                    domainName
                )
            })
            .then(function () {
                return self.dataStore
                    .getAppsDataStore()
                    .setSslForDefaultSubDomain(appName, true)
            })
            .then(function () {
                return self.reloadLoadBalancer()
            })
    }

    verifyCaptainOwnsGenericSubDomain(appName: string) {
        const self = this

        let rootDomain: string

        return Promise.resolve()
            .then(function () {
                return self.dataStore.getRootDomain()
            })
            .then(function (val) {
                rootDomain = val
            })
            .then(function () {
                // it will ensure that the app exists, otherwise it throws an exception
                return self.dataStore
                    .getAppsDataStore()
                    .getAppDefinition(appName)
            })
            .then(function () {
                return `${appName}.${rootDomain}`
            })
            .then(function (domainName) {
                Logger.d(`Verifying Captain owns domain: ${domainName}`)

                return self.domainResolveChecker.verifyCaptainOwnsDomainOrThrow(
                    domainName,
                    undefined
                )
            })
    }

    renameApp(oldAppName: string, newAppName: string) {
        Logger.d(`Renaming app: ${oldAppName}`)
        const self = this

        const dockerApi = this.dockerApi
        const dataStore = this.dataStore

        let defaultSslOn = false
        let oldServiceName: string

        return Promise.resolve()
            .then(function () {
                return dataStore.getAppsDataStore().getAppDefinition(oldAppName)
            })
            .then(function (appDef) {
                defaultSslOn = !!appDef.hasDefaultSubDomainSsl
                oldServiceName = dataStore
                    .getAppsDataStore()
                    .getServiceName(oldAppName, !!appDef.isLegacyAppName)

                dataStore.getAppsDataStore().nameAllowedOrThrow(newAppName)

                return self.ensureNotBuilding(oldAppName)
            })
            .then(function () {
                Logger.d(`Check if service is running: ${oldServiceName}`)
                return dockerApi.isServiceRunningByName(oldServiceName)
            })
            .then(function (isRunning) {
                if (!isRunning) {
                    throw ApiStatusCodes.createError(
                        ApiStatusCodes.STATUS_ERROR_GENERIC,
                        'Service is not running!'
                    )
                }
                return dockerApi.removeServiceByName(oldServiceName)
            })
            .then(function () {
                return dataStore
                    .getAppsDataStore()
                    .renameApp(self.authenticator, oldAppName, newAppName)
            })
            .then(function () {
                return self.ensureServiceInitedAndUpdated(newAppName)
            })
            .then(function () {
                if (defaultSslOn) return self.enableSslForApp(newAppName)
            })
    }

    removeApps(appNames: string[]) {
        Logger.d(`Removing service for: ${appNames.join(', ')}`)
        const self = this

        const removeAppPromise = function (appName: string) {
            const dockerApi = self.dockerApi
            const dataStore = self.dataStore
            let serviceName: string

            return Promise.resolve()
                .then(function () {
                    return dataStore
                        .getAppsDataStore()
                        .getAppDefinition(appName)
                })
                .then(function (appDef) {
                    serviceName = dataStore
                        .getAppsDataStore()
                        .getServiceName(appName, !!appDef.isLegacyAppName)
                    return self.ensureNotBuilding(appName)
                })
                .then(function () {
                    Logger.d(`Check if service is running: ${serviceName}`)
                    return dockerApi.isServiceRunningByName(serviceName)
                })
                .then(function (isRunning) {
                    if (isRunning) {
                        return dockerApi.removeServiceByName(serviceName)
                    } else {
                        Logger.w(
                            `Cannot delete service... It is not running: ${serviceName}`
                        )
                        return true
                    }
                })
                .then(function () {
                    return dataStore
                        .getAppsDataStore()
                        .deleteAppDefinition(appName)
                })
                .then(function () {
                    return self.reloadLoadBalancer()
                })
        }

        const promises = []
        for (const appName of appNames) {
            promises.push(removeAppPromise(appName))
        }

        return Promise.all(promises)
    }

    removeVolsSafe(volumes: IHashMapGeneric<string>) {
        const dockerApi = this.dockerApi
        const dataStore = this.dataStore

        const volsFailedToDelete: IHashMapGeneric<boolean> = {}

        return Promise.resolve()
            .then(function () {
                return dataStore.getAppsDataStore().getAppDefinitions()
            })
            .then(function (apps) {
                const physicalVolumesInUse: IHashMapGeneric<boolean> = {}

                Object.keys(apps).forEach((appName) => {
                    const app = apps[appName]
                    const volsInApp = app.volumes || []

                    volsInApp.forEach((volume) => {
                        const volumeName = volume.volumeName
                        if (!volumeName) {
                            return
                        }

                        const physicalVolumeName = dataStore
                            .getAppsDataStore()
                            .getVolumeName(volumeName, !!app.isLegacyAppName)
                        physicalVolumesInUse[physicalVolumeName] = true
                    })
                })

                const volumesTryToDelete: string[] = []
                Object.keys(volumes).forEach((physicalVolumeName) => {
                    const logicalVolumeName = volumes[physicalVolumeName]
                    if (physicalVolumesInUse[physicalVolumeName]) {
                        volsFailedToDelete[logicalVolumeName] = true
                    } else {
                        volumesTryToDelete.push(physicalVolumeName)
                    }
                })

                return dockerApi.deleteVols(volumesTryToDelete)
            })
            .then(function (failedVols) {
                failedVols.forEach((physicalVolumeName) => {
                    const logicalVolumeName =
                        volumes[physicalVolumeName] || physicalVolumeName
                    volsFailedToDelete[logicalVolumeName] = true
                })

                return Object.keys(volsFailedToDelete)
            })
    }

    createPreDeployFunctionIfExist(
        app: IAppDef
    ): PreDeployFunction | undefined {
        let preDeployFunction = app.preDeployFunction

        if (!preDeployFunction) {
            return undefined
        }

        /*
        ////////////////////////////////// Expected content of the file //////////////////////////

            console.log('-------------------------------'+new Date());

            preDeployFunction = function (captainAppObj, dockerUpdateObject) {
                return Promise.resolve()
                        .then(function(){
                            console.log(JSON.stringify(dockerUpdateObject));
                            return dockerUpdateObject;
                        });
            };
         */

        preDeployFunction =
            preDeployFunction + '\n\n module.exports = preDeployFunction'

        return requireFromString(preDeployFunction)
    }

    private restoreAppDefinition(appName: string, snapshot: IAppDef) {
        const self = this
        return self.dataStore.getAppsDataStore().updateAppDefinitionInDb(
            appName,
            snapshot.projectId,
            snapshot.description,
            snapshot.instanceCount,
            snapshot.captainDefinitionRelativeFilePath,
            snapshot.envVars,
            snapshot.volumes,
            snapshot.tags || [],
            snapshot.nodeId || '',
            snapshot.notExposeAsWebApp,
            snapshot.containerHttpPort || 80,
            snapshot.httpAuth,
            snapshot.forceSsl,
            snapshot.ports,
            snapshot.appPushWebhook?.repoInfo || {
                repo: '',
                branch: '',
                user: '',
                password: '',
            },
            self.authenticator,
            snapshot.customNginxConfig || '',
            snapshot.redirectDomain || '',
            snapshot.preDeployFunction || '',
            snapshot.serviceUpdateOverride || '',
            snapshot.websocketSupport,
            snapshot.appDeployTokenConfig || {
                enabled: false,
            }
        )
    }

    ensureNotBuilding(appName: string) {
        if (this.activeOrScheduledBuilds[appName])
            throw ApiStatusCodes.createError(
                ApiStatusCodes.ILLEGAL_OPERATION,
                `Build in-progress for ${appName}. Please wait...`
            )
    }

    updateAppDefinition(
        appName: string,
        projectId: string,
        description: string,
        instanceCount: number,
        captainDefinitionRelativeFilePath: string,
        envVars: IAppEnvVar[],
        volumes: IAppVolume[],
        tags: IAppTag[],
        nodeId: string,
        notExposeAsWebApp: boolean,
        containerHttpPort: number,
        httpAuth: IHttpAuth | undefined,
        forceSsl: boolean,
        ports: IAppPort[],
        repoInfo: RepoInfo,
        customNginxConfig: string,
        redirectDomain: string,
        preDeployFunction: string,
        serviceUpdateOverride: string,
        websocketSupport: boolean,
        appDeployTokenConfig: AppDeployTokenConfig,
        skipServiceUpdate?: boolean
    ) {
        const self = this
        const dataStore = this.dataStore
        const dockerApi = this.dockerApi

        let serviceName: string

        let existingAppDefinition: IAppDef

        const checkIfNodeIdExists = function (nodeIdToCheck: string) {
            return dockerApi.getNodesInfo().then(function (nodeInfo) {
                for (let i = 0; i < nodeInfo.length; i++) {
                    if (nodeIdToCheck === nodeInfo[i].nodeId) {
                        return
                    }
                }

                throw ApiStatusCodes.createError(
                    ApiStatusCodes.STATUS_ERROR_GENERIC,
                    `Node ID you requested is not part of the swarm cluster: ${nodeIdToCheck}`
                )
            })
        }

        return Promise.resolve()
            .then(function () {
                projectId = `${projectId || ''}`.trim()
                if (projectId) {
                    return dataStore
                        .getProjectsDataStore()
                        .getProject(projectId)

                    // if project is not found, it will throw an error
                }
            })
            .then(function () {
                return self.ensureNotBuilding(appName)
            })
            .then(function () {
                return dataStore.getAppsDataStore().getAppDefinition(appName)
            })
            .then(function (app) {
                serviceName = dataStore
                    .getAppsDataStore()
                    .getServiceName(appName, !!app.isLegacyAppName)

                // After leaving this block, nodeId will be guaranteed to be NonNull
                if (app.hasPersistentData) {
                    if (nodeId) {
                        return checkIfNodeIdExists(nodeId)
                    } else {
                        if (app.nodeId) {
                            nodeId = app.nodeId
                        } else {
                            return dockerApi
                                .isServiceRunningByName(serviceName)
                                .then(function (isRunning: boolean) {
                                    if (!isRunning) {
                                        throw ApiStatusCodes.createError(
                                            ApiStatusCodes.STATUS_ERROR_GENERIC,
                                            'Cannot find the service. Try again in a minute...'
                                        )
                                    }
                                    return dockerApi.getNodeIdByServiceName(
                                        serviceName,
                                        0
                                    )
                                })
                                .then(function (nodeIdRunningService: string) {
                                    if (!nodeIdRunningService) {
                                        throw ApiStatusCodes.createError(
                                            ApiStatusCodes.STATUS_ERROR_GENERIC,
                                            'No NodeId was found. Try again in a minute...'
                                        )
                                    }

                                    nodeId = nodeIdRunningService
                                })
                        }
                    }
                } else {
                    if (volumes && volumes.length) {
                        throw ApiStatusCodes.createError(
                            ApiStatusCodes.ILLEGAL_OPERATION,
                            'Cannot set volumes for a non-persistent container!'
                        )
                    }

                    if (nodeId) {
                        return checkIfNodeIdExists(nodeId)
                    }
                }
            })
            .then(function () {
                serviceUpdateOverride = serviceUpdateOverride
                    ? `${serviceUpdateOverride}`.trim()
                    : ''
                if (!serviceUpdateOverride) {
                    // no override!
                    return
                }

                if (!Utils.convertYamlOrJsonToObject(serviceUpdateOverride)) {
                    throw ApiStatusCodes.createError(
                        ApiStatusCodes.ILLEGAL_PARAMETER,
                        'serviceUpdateOverride must be either a valid JSON object starting with { or an equivalent yaml'
                    )
                }
            })
            .then(function () {
                return dataStore.getAppsDataStore().getAppDefinition(appName)
            })
            .then(function (appDef) {
                existingAppDefinition = appDef
                if (skipServiceUpdate) {
                    if (!self.pendingPreStagedDefinitions[appName]) {
                        self.pendingPreStagedDefinitions[appName] = JSON.parse(
                            JSON.stringify(appDef)
                        )
                    }
                } else {
                    delete self.pendingPreStagedDefinitions[appName]
                }

                return dataStore
                    .getAppsDataStore()
                    .updateAppDefinitionInDb(
                        appName,
                        projectId,
                        description,
                        instanceCount,
                        captainDefinitionRelativeFilePath,
                        envVars,
                        volumes,
                        tags,
                        nodeId,
                        notExposeAsWebApp,
                        containerHttpPort,
                        httpAuth,
                        forceSsl,
                        ports,
                        repoInfo,
                        self.authenticator,
                        customNginxConfig,
                        redirectDomain,
                        preDeployFunction,
                        serviceUpdateOverride,
                        websocketSupport,
                        appDeployTokenConfig
                    )
            })
            .then(function () {
                if (skipServiceUpdate) {
                    Logger.d(
                        `Pre-staged definition saved for ${appName}; skipping service update until next deployment.`
                    )
                    return
                }
                return self.ensureServiceInitedAndUpdated(appName)
            })
            .catch(function (error) {
                if (
                    error &&
                    error.captainErrorType ===
                        ApiStatusCodes.STATUS_ERROR_NGINX_VALIDATION_FAILED
                ) {
                    // Revert back to the old definition because the nginx config is invalid
                    if (existingAppDefinition) {
                        Logger.d(
                            `nginx validation failed, reverting configs for: ${appName}`
                        )
                        return self
                            .restoreAppDefinition(
                                appName,
                                existingAppDefinition
                            )
                            .then(function () {
                                self.reloadLoadBalancer()
                            })
                            .then(function () {
                                throw error
                            })
                    }
                }

                throw error
            })
    }

    isAppBuilding(appName: string) {
        return !!this.activeOrScheduledBuilds[appName]
    }

    /**
     *
     * @returns the active build that it finds
     */
    isAnyBuildRunning() {
        const activeBuilds = this.activeOrScheduledBuilds

        for (const appName in activeBuilds) {
            if (activeBuilds[appName]) {
                return appName
            }
        }

        return undefined
    }

    getBuildStatus(appName: string) {
        const self = this

        return {
            isAppBuilding: self.isAppBuilding(appName),
            logs: self.buildLogsManager.getAppBuildLogs(appName).getLogs(),
            isBuildFailed:
                self.buildLogsManager.getAppBuildLogs(appName).isBuildFailed,
        }
    }

    getCandidateBuildLog(appName: string, receipt: string): string | undefined {
        if (this.activeCandidateBuilds.get(appName) !== receipt) return
        return this.buildLogTail(appName)
    }

    candidateBuildState(appName: string, receipt: string) {
        if (this.activeCandidateBuilds.get(appName) === receipt)
            return 'building'
        if (
            this.queuedBuilds.some(
                (build) =>
                    build.appName === appName &&
                    build.source.buildReceipt === receipt
            )
        )
            return 'queued'
        return undefined
    }

    isCandidateBuildStopping(appName: string, receipt: string) {
        const key = appName + ':' + receipt
        return (
            this.candidateStops.has(key) ||
            this.stoppedBuildUploads.has(key) ||
            (this.activeCandidateBuilds.get(appName) === receipt &&
                this.candidateBuildControllers.get(appName)?.signal.aborted ===
                    true)
        )
    }

    async stopCandidateBuild(
        appName: string,
        receipt: string
    ): Promise<boolean> {
        const reason = new Error('Candidate image build cancelled')
        if (this.activeCandidateBuilds.get(appName) === receipt) {
            this.candidateBuildControllers.get(appName)?.abort(reason)
            return false
        }
        if (
            this.isAppBuilding(appName) &&
            this.candidateBuildState(appName, receipt) !== 'queued'
        ) {
            return false
        }
        const key = appName + ':' + receipt
        if (this.candidateStops.has(key)) return false
        this.candidateStops.add(key)
        try {
            const queued = this.queuedBuilds.findIndex(
                (build) =>
                    build.appName === appName &&
                    build.source.buildReceipt === receipt
            )
            if (queued >= 0) {
                const [build] = this.queuedBuilds.splice(queued, 1)
                this.activeOrScheduledBuilds[appName] = false
                const upload =
                    build.source.uploadedTarPathSource?.uploadedTarPath
                if (upload) this.stoppedBuildUploads.set(key, upload)
                build.promiseToSave.reject?.(reason)
            }
            const upload = this.stoppedBuildUploads.get(key)
            if (upload) {
                await fs.remove(upload)
                this.stoppedBuildUploads.delete(key)
            }
            const apps = this.dataStore.getAppsDataStore()
            const app = (await apps.getAppDefinitions())[appName]
            if (app) {
                const version = app.versions.find(
                    (item) => item.preparedBuild?.receipt === receipt
                )
                if (
                    !version?.preparedBuild?.image &&
                    !version?.preparedBuild?.error
                ) {
                    const id =
                        version?.version ??
                        (await apps.createNewVersion(appName, receipt))
                    await apps.savePreparedBuild(appName, id, {
                        error: reason.message,
                        log: version?.preparedBuild?.log ?? '',
                    })
                }
            }
            return true
        } finally {
            this.candidateStops.delete(key)
        }
    }

    private buildLogTail(appName: string) {
        const lines: string[] = this.getBuildStatus(appName).logs.lines
        return lines.join('\n').trim().slice(-12_000)
    }

    getAppsRuntime(): Promise<AppsRuntimeResponse> {
        const appsDataStore = this.dataStore.getAppsDataStore()
        const dockerApi = this.dockerApi
        let appNames: string[]

        return Promise.resolve()
            .then(function () {
                return appsDataStore.getAppDefinitions()
            })
            .then(function (apps) {
                appNames = Object.keys(apps)
                return dockerApi.getServiceRuntimes(
                    appNames.map(function (appName) {
                        return appsDataStore.getServiceName(
                            appName,
                            !!apps[appName].isLegacyAppName
                        )
                    })
                )
            })
            .then(function (runtimes) {
                return {
                    apps: runtimes.map(function (runtime, index) {
                        return {
                            appName: appNames[index],
                            status: runtime.status,
                            desiredInstances: runtime.desiredInstances,
                            runningInstances: runtime.runningInstances,
                            currentTasks: runtime.currentTasks,
                            latestFailure: runtime.latestFailure,
                            error: runtime.error,
                        }
                    }),
                }
            })
    }

    async restartApplication(
        appName: string,
        operationId: string,
        changes: IAppEnvVar[]
    ) {
        this.ensureNotBuilding(appName)
        const apps = this.dataStore.getAppsDataStore()
        const app = await apps.getAppDefinition(appName)
        this.ensureNotBuilding(appName)
        await this.dockerApi.restartApplication(
            apps.getServiceName(appName, !!app.isLegacyAppName),
            operationId,
            changes
        )
        if (changes.length)
            await apps.updateRuntimeEnvironment(appName, changes)
    }

    getAppRuntime(appName: string): Promise<AppRuntimeDetails> {
        const appsDataStore = this.dataStore.getAppsDataStore()
        const dockerApi = this.dockerApi

        return Promise.resolve()
            .then(function () {
                return appsDataStore.getAppDefinitions()
            })
            .then(function (apps) {
                if (!Object.prototype.hasOwnProperty.call(apps, appName)) {
                    throw ApiStatusCodes.createError(
                        ApiStatusCodes.NOT_FOUND,
                        'App not found'
                    )
                }
                const app = apps[appName]
                const serviceName = appsDataStore.getServiceName(
                    appName,
                    !!app.isLegacyAppName
                )
                return dockerApi.getServiceRuntimes([serviceName])
            })
            .then(function (runtimes) {
                return { appName, ...runtimes[0] }
            })
    }

    async getAppResourceMetrics(appName: string) {
        const appsDataStore = this.dataStore.getAppsDataStore()
        const apps = await appsDataStore.getAppDefinitions()
        if (!Object.prototype.hasOwnProperty.call(apps, appName)) {
            throw ApiStatusCodes.createError(
                ApiStatusCodes.NOT_FOUND,
                'App not found'
            )
        }
        const app = apps[appName]
        const serviceName = appsDataStore.getServiceName(
            appName,
            !!app.isLegacyAppName
        )
        const metrics = await this.dockerApi.getServiceResourceMetrics(
            serviceName
        )
        return { appName, ...metrics }
    }

    async setApplicationWriteHold(appName: string, hold: boolean) {
        if (this.isAppBuilding(appName)) {
            throw new Error(
                'The application deployment must settle before changing its write hold'
            )
        }
        const apps = this.dataStore.getAppsDataStore()
        const app = await apps.getAppDefinition(appName)
        await this.dockerApi.setApplicationReplicas(
            apps.getServiceName(appName, !!app.isLegacyAppName),
            hold ? 0 : app.instanceCount,
            hold
        )
    }

    async startDeliveryCandidate(
        appName: string,
        receipt: string,
        env: IAppEnvVar[],
        sandbox: CandidateSandbox
    ) {
        const app = await this.dataStore
            .getAppsDataStore()
            .getAppDefinition(appName)
        const image = app.versions.find(
            (version) => version.preparedBuild?.receipt === receipt
        )?.preparedBuild?.image
        if (!image)
            throw new Error(
                'An image from the requested delivery build is required'
            )
        await this.dockerApi.startDeliveryCandidate(
            appName,
            receipt,
            image,
            env,
            sandbox
        )
    }

    probeDeliveryCandidate(
        appName: string,
        receipt: string,
        port: number,
        request: CandidateRequest
    ) {
        return this.dockerApi.probeDeliveryCandidate(
            appName,
            receipt,
            port,
            request
        )
    }

    stopDeliveryCandidate(appName: string, receipt: string) {
        return this.dockerApi.stopDeliveryCandidate(appName, receipt)
    }

    getDeliveryCandidateLogs(appName: string, receipt: string) {
        return this.dockerApi.getDeliveryCandidateLogs(appName, receipt)
    }

    async isApplicationWriteHeld(appName: string) {
        const apps = this.dataStore.getAppsDataStore()
        const app = await apps.getAppDefinition(appName)
        return this.dockerApi.isApplicationWriteHeld(
            apps.getServiceName(appName, !!app.isLegacyAppName)
        )
    }

    logBuildFailed(appName: string, error: string) {
        const self = this
        error = (error || '') + ''

        self.eventLogger.trackEvent(
            CapRoverEventFactory.create(CapRoverEventType.AppBuildFailed, {
                appName,
                error: error.substring(0, 1000),
            })
        )
        this.buildLogsManager.getAppBuildLogs(appName).onBuildFailed(error)
    }

    getAppLogs(appName: string, encoding: string) {
        const dockerApi = this.dockerApi
        const dataStore = this.dataStore
        let serviceName: string

        return Promise.resolve() //
            .then(function () {
                return dataStore.getAppsDataStore().getAppDefinition(appName)
            })
            .then(function (appDef) {
                serviceName = dataStore
                    .getAppsDataStore()
                    .getServiceName(appName, !!appDef.isLegacyAppName)
                return dockerApi.getLogForService(
                    serviceName,
                    CaptainConstants.configs.appLogSize,
                    encoding
                )
            })
    }

    ensureServiceInitedAndUpdated(appName: string) {
        Logger.d(`Ensure service inited and Updated for: ${appName}`)
        const self = this

        let imageName: string | undefined
        const dockerApi = this.dockerApi
        const dataStore = this.dataStore
        let app: IAppDef
        let dockerAuthObject: DockerAuthObj | undefined
        let serviceName: string

        return Promise.resolve() //
            .then(function () {
                return dataStore.getAppsDataStore().getAppDefinition(appName)
            })
            .then(function (appFound) {
                app = appFound
                serviceName = dataStore
                    .getAppsDataStore()
                    .getServiceName(appName, !!app.isLegacyAppName)

                Logger.d(`Check if service is running: ${serviceName}`)
                return dockerApi.isServiceRunningByName(serviceName)
            })
            .then(function (isRunning) {
                for (let i = 0; i < app.versions.length; i++) {
                    const element = app.versions[i]
                    if (element.version === app.deployedVersion) {
                        imageName = element.deployedImageName
                        break
                    }
                }

                if (!imageName) {
                    throw ApiStatusCodes.createError(
                        ApiStatusCodes.ILLEGAL_PARAMETER,
                        'ImageName for deployed version is not available, this version was probably failed due to an unsuccessful build!'
                    )
                }

                if (isRunning) {
                    Logger.d(`Service is already running: ${serviceName}`)
                    return true
                } else {
                    Logger.d(
                        `Creating service ${serviceName} with default image, we will update image later`
                    )

                    // if we pass in networks here. Almost always it results in a delayed update which causes
                    // update errors if they happen right away!
                    return dockerApi
                        .createServiceOnNodeId(
                            CaptainConstants.configs.appPlaceholderImageName,
                            serviceName,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            undefined
                        )
                        .then(() => true)
                }
            })
            .then(function () {
                return self.dockerRegistryHelper.getDockerAuthObjectForImageName(
                    imageName!
                )
            })
            .then(function (data) {
                dockerAuthObject = data
            })
            .then(function () {
                return self.createPreDeployFunctionIfExist(app)
            })
            .then(function (preDeployFunction) {
                Logger.d(
                    `Updating service ${serviceName} with image ${imageName}`
                )

                return dockerApi.updateService(
                    serviceName,
                    imageName,
                    app.volumes,
                    app.networks,
                    app.envVars,
                    undefined,
                    dockerAuthObject,
                    Number(app.instanceCount),
                    app.nodeId,
                    dataStore.getNameSpace(),
                    app.ports,
                    app,
                    IDockerUpdateOrders.AUTO,
                    Utils.convertYamlOrJsonToObject(app.serviceUpdateOverride),
                    preDeployFunction
                )
            })
            .then(function () {
                return new Promise<void>(function (resolve) {
                    // Waiting 2 extra seconds for docker DNS to pickup the service name
                    setTimeout(resolve, 2000)
                })
            })
            .then(function () {
                return self.reloadLoadBalancer()
            })
    }

    reloadLoadBalancer() {
        Logger.d('Updating Load Balancer - ServiceManager')
        const self = this
        return self.loadBalancerManager.rePopulateNginxConfigFile()
    }
}

export default ServiceManager

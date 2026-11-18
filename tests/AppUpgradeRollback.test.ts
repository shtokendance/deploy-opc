import fs = require('fs-extra')
import os = require('os')
import path = require('path')
import ImageMaker, { BuildLogsManager } from '../src/user/ImageMaker'
import ServiceManager from '../src/user/ServiceManager'
import DiskCleanupManager from '../src/user/system/DiskCleanupManager'
import CaptainConstants from '../src/utils/CaptainConstants'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
        resolve = res
    })
    return { promise, resolve }
}

describe('App upgrade, rollback, and cleanup regressions', () => {
    afterEach(() => {
        jest.restoreAllMocks()
    })

    test('ImageMaker.ensureImage reuses local image without calling pullImage', async () => {
        const tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'deploy-opc-test-')
        )
        jest.replaceProperty(
            CaptainConstants,
            'captainRawSourceDirectoryBase',
            tmpDir
        )

        const dockerApi = {
            isImageAvailableLocally: jest.fn().mockResolvedValue(true),
            pullImage: jest.fn(),
        }
        const dockerRegistryHelper = {
            getDockerAuthObjectForImageName: jest.fn(),
        }
        const logsManager = new BuildLogsManager()
        const maker = new ImageMaker(
            dockerRegistryHelper as any,
            dockerApi as any,
            'captain',
            logsManager
        )

        const result = await maker.ensureImage(
            {
                captainDefinitionContentSource: {
                    captainDefinitionContent: JSON.stringify({
                        schemaVersion: 2,
                        imageName: 'img-captain-demo:1',
                    }),
                    gitHash: '',
                },
            },
            'demo',
            './captain-definition',
            2,
            []
        )

        expect(result.imageName).toBe('img-captain-demo:1')
        expect(dockerApi.isImageAvailableLocally).toHaveBeenCalledWith(
            'img-captain-demo:1'
        )
        expect(dockerApi.pullImage).not.toHaveBeenCalled()
        await fs.remove(tmpDir)
    })

    test('ImageMaker.ensureImage pulls remote image when not available locally', async () => {
        const tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'deploy-opc-test-')
        )
        jest.replaceProperty(
            CaptainConstants,
            'captainRawSourceDirectoryBase',
            tmpDir
        )

        const dockerApi = {
            isImageAvailableLocally: jest.fn().mockResolvedValue(false),
            pullImage: jest.fn().mockResolvedValue(undefined),
        }
        const dockerRegistryHelper = {
            getDockerAuthObjectForImageName: jest
                .fn()
                .mockResolvedValue(undefined),
        }
        const logsManager = new BuildLogsManager()
        const maker = new ImageMaker(
            dockerRegistryHelper as any,
            dockerApi as any,
            'captain',
            logsManager
        )

        const result = await maker.ensureImage(
            {
                captainDefinitionContentSource: {
                    captainDefinitionContent: JSON.stringify({
                        schemaVersion: 2,
                        imageName: 'nginx:alpine',
                    }),
                    gitHash: '',
                },
            },
            'demo',
            './captain-definition',
            2,
            []
        )

        expect(result.imageName).toBe('nginx:alpine')
        expect(dockerApi.isImageAvailableLocally).toHaveBeenCalledWith(
            'nginx:alpine'
        )
        expect(dockerApi.pullImage).toHaveBeenCalledWith(
            'nginx:alpine',
            undefined
        )
        await fs.remove(tmpDir)
    })

    test('ServiceManager keeps isAppBuilding true during service update and queued same-app build', async () => {
        const firstImage = deferred<string>()
        const firstServiceUpdate = deferred<void>()
        const secondImage = deferred<string>()
        const ensureImage = jest
            .fn()
            .mockReturnValueOnce(firstImage.promise)
            .mockReturnValueOnce(secondImage.promise)

        const appsDataStore = {
            createNewVersion: jest
                .fn()
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(2),
            getAppDefinition: jest.fn().mockResolvedValue({
                envVars: [],
                captainDefinitionRelativeFilePath: './captain-definition',
            }),
            setDeployedVersionAndImage: jest.fn().mockResolvedValue(undefined),
        }
        const manager = new ServiceManager(
            {
                getNameSpace: () => 'captain',
                getAppsDataStore: () => appsDataStore,
                getRegistriesDataStore: () => ({}),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            { trackEvent: jest.fn() } as any,
            {} as any
        )
        ;(manager as any).imageMaker = { ensureImage }
        jest.spyOn(manager, 'ensureServiceInitedAndUpdated')
            .mockReturnValueOnce(firstServiceUpdate.promise as any)
            .mockResolvedValue(undefined as any)

        const source = {
            captainDefinitionContentSource: {
                captainDefinitionContent: '{}',
                gitHash: '',
            },
        }
        const firstRun = manager.scheduleDeployNewVersion('demo', source)
        const secondRun = manager.scheduleDeployNewVersion('demo', source)

        firstImage.resolve('img-captain-demo:1')
        await new Promise((resolve) => setTimeout(resolve, 20))

        // Service update is still pending; build lock must remain active
        expect(manager.isAppBuilding('demo')).toBe(true)

        firstServiceUpdate.resolve(undefined)
        await firstRun
        await new Promise((resolve) => setTimeout(resolve, 20))

        // Second build of the same app is now running; build lock must remain true
        expect(manager.isAppBuilding('demo')).toBe(true)

        secondImage.resolve('img-captain-demo:2')
        await secondRun
        expect(manager.isAppBuilding('demo')).toBe(false)
    })

    test('DiskCleanupManager preserves rollback image across failed intermediate versions', async () => {
        const dockerApi = {
            getImages: jest.fn().mockResolvedValue([
                { Id: 'id-v4', RepoTags: ['img-captain-demo:4'] },
                { Id: 'id-v1', RepoTags: ['img-captain-demo:1'] },
                { Id: 'id-v0', RepoTags: ['img-captain-demo:0'] },
            ]),
        }
        const dataStore = {
            getAppsDataStore: () => ({
                getAppDefinitions: jest.fn().mockResolvedValue({
                    demo: {
                        deployedVersion: 4,
                        versions: [
                            {
                                version: 1,
                                deployedImageName: 'img-captain-demo:1',
                            },
                            { version: 2 },
                            { version: 3 },
                            {
                                version: 4,
                                deployedImageName: 'img-captain-demo:4',
                            },
                        ],
                    },
                }),
            }),
        }

        const cleanup = new DiskCleanupManager(
            dataStore as any,
            dockerApi as any
        )
        const unused = await cleanup.getUnusedImages(1)

        expect(unused.map((x) => x.id)).toEqual(['id-v0'])
    })

    test('updateAppDefinition skipServiceUpdate pre-stages config and restores baseline on build failure', async () => {
        const oldDef = {
            appName: 'demo',
            projectId: '',
            description: 'v1',
            instanceCount: 1,
            captainDefinitionRelativeFilePath: './captain-definition',
            envVars: [{ key: 'VER', value: 'v1' }],
            volumes: [],
            tags: [],
            nodeId: '',
            notExposeAsWebApp: false,
            containerHttpPort: 8080,
            forceSsl: false,
            ports: [],
            websocketSupport: true,
            serviceUpdateOverride: '',
            customNginxConfig: '',
            redirectDomain: '',
            preDeployFunction: '',
            appDeployTokenConfig: { enabled: false },
        }
        const updateAppDefinitionInDb = jest.fn().mockResolvedValue(undefined)
        const appsDataStore = {
            getAppDefinition: jest.fn().mockResolvedValue(oldDef),
            getServiceName: jest.fn((name: string) => `srv-captain--${name}`),
            updateAppDefinitionInDb,
            createNewVersion: jest.fn().mockResolvedValue(2),
            setDeployedVersionAndImage: jest.fn().mockResolvedValue(undefined),
        }
        const manager = new ServiceManager(
            {
                getNameSpace: () => 'captain',
                getAppsDataStore: () => appsDataStore,
                getRegistriesDataStore: () => ({}),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            { trackEvent: jest.fn() } as any,
            {} as any
        )
        const ensureServiceSpy = jest
            .spyOn(manager, 'ensureServiceInitedAndUpdated')
            .mockResolvedValue(undefined as any)

        await manager.updateAppDefinition(
            'demo',
            '',
            'v2',
            1,
            './captain-definition',
            [{ key: 'VER', value: 'v2' }],
            [],
            [],
            '',
            false,
            9090,
            undefined,
            false,
            [],
            { repo: '', branch: '', user: '', password: '' },
            '',
            '',
            '',
            '{"TaskTemplate":{}}',
            true,
            { enabled: false },
            true
        )

        expect(updateAppDefinitionInDb).toHaveBeenCalledTimes(1)
        expect(ensureServiceSpy).not.toHaveBeenCalled()

        // Now fail the subsequent build -> pre-staged definition must revert to oldDef
        ;(manager as any).imageMaker = {
            ensureImage: jest
                .fn()
                .mockRejectedValue(new Error('simulated v2 build failure')),
        }

        await expect(
            manager.scheduleDeployNewVersion('demo', {
                captainDefinitionContentSource: {
                    captainDefinitionContent: '{}',
                    gitHash: '',
                },
            })
        ).rejects.toThrow('simulated v2 build failure')

        expect(updateAppDefinitionInDb).toHaveBeenCalledTimes(2)
        const revertCall = updateAppDefinitionInDb.mock.calls[1]
        expect(revertCall[5]).toEqual([{ key: 'VER', value: 'v1' }])
        expect(revertCall[10]).toBe(8080)
    })
})

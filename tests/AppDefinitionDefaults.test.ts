import configstore = require('configstore')
import AppsDataStore from '../src/datastore/AppsDataStore'
import DataStore from '../src/datastore/DataStore'
import { registerAppDefinition } from '../src/handlers/users/apps/appdefinition/AppDefinitionHandler'
import { IAppDef } from '../src/models/AppDefinition'
import ServiceManager from '../src/user/ServiceManager'

describe('app definition defaults', () => {
    test('enables WebSocket support for new apps without changing existing apps', async () => {
        const existingApp = { websocketSupport: false }
        const data = {
            get: jest.fn((key: string) =>
                key === 'appDefinitions.existing-app' ? existingApp : undefined
            ),
            set: jest.fn(),
        } as unknown as configstore
        const appsDataStore = new AppsDataStore(data, 'captain')

        await appsDataStore.registerAppDefinition('new-app', undefined, false)

        expect(data.set).toHaveBeenCalledWith(
            'appDefinitions.new-app',
            expect.objectContaining({ websocketSupport: true })
        )
        expect(data.set).toHaveBeenCalledTimes(1)
        expect(existingApp.websocketSupport).toBe(false)
    })

    test('candidate-only registration stores a hidden definition without deploying a placeholder', async () => {
        const data = {
            get: jest.fn(),
            set: jest.fn(),
        } as unknown as configstore
        const apps = new AppsDataStore(data, 'captain')
        const dataStore = {
            getAppsDataStore: () => apps,
        } as unknown as DataStore
        const scheduleDeployNewVersion = jest.fn()
        const serviceManager = {
            scheduleDeployNewVersion,
        } as unknown as ServiceManager

        await registerAppDefinition(
            {
                appName: 'candidate-app',
                projectId: '',
                hasPersistentData: false,
                isDetachedBuild: false,
                candidateOnly: true,
            },
            dataStore,
            serviceManager
        )

        expect(data.set).toHaveBeenCalledWith(
            'appDefinitions.candidate-app',
            expect.objectContaining({
                notExposeAsWebApp: true,
                deployedVersion: 0,
            })
        )
        expect(scheduleDeployNewVersion).not.toHaveBeenCalled()
    })

    test('an interrupted candidate build reuses its version instead of allocating another', async () => {
        const data = {
            get: jest.fn(),
            set: jest.fn(),
        } as unknown as configstore
        const apps = new AppsDataStore(data, 'captain')
        const receipt = '55711c0b-06de-4345-9f09-439bfdf4b2f2'
        jest.spyOn(apps, 'getAppDefinition').mockResolvedValue({
            deployedVersion: 3,
            versions: [{ version: 8, preparedBuild: { receipt } }],
        } as IAppDef)

        await expect(
            apps.createNewVersion('candidate-app', receipt)
        ).resolves.toBe(8)
        expect(data.set).not.toHaveBeenCalled()
    })
})

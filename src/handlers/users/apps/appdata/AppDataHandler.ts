import ApiStatusCodes from '../../../../api/ApiStatusCodes'
import ServiceManager from '../../../../user/ServiceManager'
import Logger from '../../../../utils/Logger'
import { BaseHandlerResult } from '../../../BaseHandlerResult'

export interface UploadCaptainDefinitionContentParams {
    appName: string
    isDetachedBuild: boolean
    captainDefinitionContent?: string
    gitHash?: string
    uploadedTarPathSource?: string
    buildReceipt?: string
}

export async function uploadCaptainDefinitionContent(
    params: UploadCaptainDefinitionContentParams,
    serviceManager: ServiceManager
): Promise<BaseHandlerResult> {
    const {
        appName,
        isDetachedBuild,
        captainDefinitionContent,
        gitHash,
        uploadedTarPathSource,
        buildReceipt,
    } = params

    const hasTar = !!uploadedTarPathSource
    const hasCaptainDef = !!captainDefinitionContent

    if (hasTar === hasCaptainDef) {
        throw ApiStatusCodes.createError(
            ApiStatusCodes.ILLEGAL_OPERATION,
            'Either uploadedTarPathSource or captainDefinitionContent should be provided, but not both.'
        )
    }
    if (
        buildReceipt &&
        (!hasTar ||
            !isDetachedBuild ||
            !/^[a-f0-9-]{32,36}$/.test(buildReceipt))
    ) {
        throw ApiStatusCodes.createError(
            ApiStatusCodes.ILLEGAL_OPERATION,
            'Prepared builds require an uploaded tar, detached mode and a valid receipt.'
        )
    }

    const promiseToDeployNewVer = serviceManager.scheduleDeployNewVersion(
        appName,
        {
            buildReceipt,
            uploadedTarPathSource: hasTar
                ? {
                      uploadedTarPath: uploadedTarPathSource as string,
                      gitHash: `${gitHash || ''}`,
                  }
                : undefined,
            captainDefinitionContentSource: hasCaptainDef
                ? {
                      captainDefinitionContent:
                          captainDefinitionContent as string,
                      gitHash: `${gitHash || ''}`,
                  }
                : undefined,
        }
    )

    if (isDetachedBuild) {
        // Avoid unhandled promise rejection
        promiseToDeployNewVer.catch(function (err: any) {
            Logger.e(err)
        })

        return {
            message: 'Deploy is started',
        }
    }

    await promiseToDeployNewVer

    return {
        message: 'Deploy is done',
    }
}

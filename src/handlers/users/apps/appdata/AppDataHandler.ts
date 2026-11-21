import ApiStatusCodes from '../../../../api/ApiStatusCodes'
import ServiceManager from '../../../../user/ServiceManager'
import Logger from '../../../../utils/Logger'
import { BaseHandlerResult } from '../../../BaseHandlerResult'
import { IAppEnvVar } from '../../../../models/AppDefinition'

export interface UploadCaptainDefinitionContentParams {
    appName: string
    isDetachedBuild: boolean
    captainDefinitionContent?: string
    gitHash?: string
    uploadedTarPathSource?: string
    buildReceipt?: string
    buildArgs?: IAppEnvVar[]
}

export function parseCandidateBuildArgs(raw: unknown): IAppEnvVar[] {
    if (raw === undefined) return []
    let data: unknown
    if (typeof raw === 'string' && Buffer.byteLength(raw) <= 512 * 1024) {
        try {
            data = JSON.parse(raw)
        } catch {
            // Use the same response for malformed JSON and invalid arguments.
        }
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const entries = Object.entries(data) as [string, unknown][]
        const args: IAppEnvVar[] = []
        let size = 0
        for (const [key, value] of entries) {
            if (
                !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
                typeof value !== 'string' ||
                value.includes('\0') ||
                Buffer.byteLength(value) > 8 * 1024
            )
                break
            size += Buffer.byteLength(key) + Buffer.byteLength(value)
            args.push({ key, value })
        }
        if (
            args.length === entries.length &&
            args.length <= 64 &&
            size <= 64 * 1024
        ) {
            return args
        }
    }
    throw ApiStatusCodes.createError(
        ApiStatusCodes.ILLEGAL_OPERATION,
        'Candidate build arguments are malformed or exceed the allowed size.'
    )
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
        buildArgs,
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
            buildArgs,
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

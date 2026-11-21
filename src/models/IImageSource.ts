import { IAppEnvVar, RepoInfo } from './AppDefinition'

export interface IImageSource {
    buildReceipt?: string
    buildArgs?: IAppEnvVar[]
    uploadedTarPathSource?: { uploadedTarPath: string; gitHash: string }
    captainDefinitionContentSource?: {
        captainDefinitionContent: string
        gitHash: string
    }
    repoInfoSource?: RepoInfo
}

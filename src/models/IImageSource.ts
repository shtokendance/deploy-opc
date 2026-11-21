import { RepoInfo } from './AppDefinition'

export interface IImageSource {
    buildReceipt?: string
    uploadedTarPathSource?: { uploadedTarPath: string; gitHash: string }
    captainDefinitionContentSource?: {
        captainDefinitionContent: string
        gitHash: string
    }
    repoInfoSource?: RepoInfo
}

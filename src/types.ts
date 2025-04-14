import type { CollectionConfig, PayloadRequest } from 'payload'
import type {
  ClientUploadsAccess,
  ClientUploadsConfig,
} from '@payloadcms/plugin-cloud-storage/types'

export type VideoStatus = 'processing' | 'ready' | 'error'

export interface File {
  buffer: Buffer
  filename: string
  filesize: number
  mimeType: string
  tempFilePath?: string
}

export interface CloudflareStreamPluginOptions {
  /**
   * 启用调试日志输出
   * @default false
   */
  debug?: boolean

  /**
   * 是否启用插件
   * @default true
   */
  enabled?: boolean

  /**
   * Cloudflare 账户 ID
   * 可从环境变量读取 - CLOUDFLARE_ACCOUNT_ID
   */
  accountId?: string

  /**
   * Cloudflare API Token
   * 可从环境变量读取 - CLOUDFLARE_API_TOKEN
   */
  apiToken?: string

  /**
   * Cloudflare Stream 域名
   * 用于生成视频观看 URL
   * 例如: https://customer-domain.cloudflarestream.com
   */
  streamDomain?: string

  /**
   * 需要使用 Cloudflare Stream 的集合名称
   * @default []
   */
  collections?: string[]

  /**
   * 是否启用客户端上传功能
   * @default false
   */
  enableClientUploads?: boolean

  /**
   * 客户端上传配置
   */
  clientUploads?: ClientUploadsConfig

  /**
   * 视频上传后的回调函数
   */
  afterUpload?: (args: {
    collection: CollectionConfig
    data: any
    file: File
    req: PayloadRequest
    streamId: string
    streamUrl: string
  }) => Promise<void> | void

  /**
   * 视频删除前的回调函数
   */
  beforeDelete?: (args: {
    collection: CollectionConfig
    doc: any
    req: PayloadRequest
    streamId: string
  }) => Promise<void> | void

  /**
   * 自定义视频处理选项
   */
  videoOptions?: {
    /**
     * 是否允许下载
     * @default false
     */
    allowDownload?: boolean

    /**
     * 是否需要签名 URL
     * @default false
     */
    requireSignedURLs?: boolean

    /**
     * 上传的最大视频时长（秒）
     */
    maxDurationSeconds?: number

    /**
     * 水印设置
     */
    watermark?: {
      imageUrl: string
      position?: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
      scale?: number
      opacity?: number
    }
  }
}

export type HandleStreamUpload = (args: {
  collection: CollectionConfig
  data: any
  file: File
  req: PayloadRequest
  options: CloudflareStreamPluginOptions
}) => Promise<{
  streamId: string
  streamUrl: string
  size: number
  duration: number
  thumbnailUrl: string
  status: VideoStatus
}>

export type HandleStreamDelete = (args: {
  collection: CollectionConfig
  doc: any
  req: PayloadRequest
  streamId: string
  options: CloudflareStreamPluginOptions
}) => Promise<void> | void

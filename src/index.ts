import type { CollectionSlug, Config } from 'payload'
import type {
  CollectionConfig,
  Field,
  CollectionBeforeChangeHook,
  CollectionAfterChangeHook,
  CollectionBeforeDeleteHook,
  PayloadRequest,
  Plugin,
  UploadCollectionSlug,
  FileData,
} from 'payload'
import type {
  Adapter,
  ClientUploadsConfig,
  CollectionOptions,
  GeneratedAdapter,
  PluginOptions as CloudStoragePluginOptions,
  StaticHandler,
  HandleUpload,
  HandleDelete,
  File as CloudStorageFile,
} from '@payloadcms/plugin-cloud-storage/types'
import { cloudStoragePlugin } from '@payloadcms/plugin-cloud-storage'
import { initClientUploads } from '@payloadcms/plugin-cloud-storage/utilities'

import { checkVideoStatus, handleStreamDelete, handleStreamUpload } from './handlers'
import type { CloudflareStreamPluginOptions, VideoStatus, File } from './types'
import { getGenerateSignedURLHandler } from './generateSignedURL'

// 客户端上传上下文类型定义
interface CloudflareStreamClientUploadContext {
  streamId: string
  [key: string]: any
}

// 扩展 FileData 接口以包含 cloudflareStream 字段
interface CloudflareStreamFileData extends FileData {
  cloudflareStream?: {
    streamId: string
    streamUrl: string
    status: VideoStatus
    uploadedAt: Date
    size?: number
    duration?: number
    thumbnailUrl?: string
  }
}

export type CloudflareStreamPluginConfig = {
  /**
   * 应用 Cloudflare Stream 到的集合列表
   */
  collections: Partial<Record<UploadCollectionSlug, Omit<CollectionOptions, 'adapter'> | true>>

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
   * 客户端上传配置
   */
  clientUploads?: ClientUploadsConfig

  /**
   * 视频上传后的回调函数
   */
  afterUpload?: CloudflareStreamPluginOptions['afterUpload']

  /**
   * 视频删除前的回调函数
   */
  beforeDelete?: CloudflareStreamPluginOptions['beforeDelete']

  /**
   * 自定义视频处理选项
   */
  videoOptions?: CloudflareStreamPluginOptions['videoOptions']

  /**
   * 是否启用客户端上传功能
   * @default false
   */
  enableClientUploads?: boolean

  /**
   * 是否禁用本地存储
   * @default true
   */
  disableLocalStorage?: boolean
}

/**
 * 创建一个字段配置，用于存储 Cloudflare Stream 相关信息
 */
const createStreamFields = (): Field[] => [
  {
    name: 'cloudflareStream',
    type: 'group',
    admin: {
      position: 'sidebar' as const,
    },
    fields: [
      {
        name: 'streamId',
        label: 'Stream ID',
        type: 'text',
        admin: {
          readOnly: true,
        },
      },
      {
        name: 'streamUrl',
        label: 'Stream URL',
        type: 'text',
        admin: {
          readOnly: true,
        },
      },
      {
        name: 'status',
        label: '状态',
        type: 'select',
        admin: {
          readOnly: true,
        },
        options: [
          {
            label: '准备中',
            value: 'processing',
          },
          {
            label: '就绪',
            value: 'ready',
          },
          {
            label: '错误',
            value: 'error',
          },
        ],
        defaultValue: 'processing',
        required: true,
      },
      {
        name: 'thumbnailUrl',
        label: '缩略图 URL',
        type: 'text',
        admin: {
          readOnly: true,
        },
      },
      {
        name: 'size',
        label: '文件大小',
        type: 'number',
        admin: {
          readOnly: true,
        },
      },
      {
        name: 'duration',
        label: '时长（秒）',
        type: 'number',
        admin: {
          readOnly: true,
        },
      },
      {
        name: 'uploadedAt',
        label: '上传时间',
        type: 'date',
        admin: {
          readOnly: true,
          date: {
            displayFormat: 'yyyy-MM-dd HH:mm:ss',
          },
        },
      },
    ],
  },
]

/**
 * 实现 Cloudflare Stream Adapter
 */
function cloudflareStreamAdapter(getOptions: () => CloudflareStreamPluginOptions): Adapter {
  return ({ collection, prefix }) => {
    const options = getOptions()

    // 生成 adapter 实现
    const adapter: GeneratedAdapter = {
      clientUploads: options.clientUploads,
      name: 'cloudflare-stream',

      // 提供字段
      fields: createStreamFields(),

      // 处理上传
      handleUpload: (async ({ data, file, clientUploadContext }) => {
        const options = getOptions()
        const { accountId, apiToken, debug } = options

        if (
          !clientUploadContext ||
          !(clientUploadContext as CloudflareStreamClientUploadContext).streamId
        ) {
          if (debug) {
            console.warn('客户端上传上下文中缺少 streamId')
          }
          return data
        }

        try {
          // 请求 Cloudflare Stream API 获取视频详细信息
          const streamId = (clientUploadContext as CloudflareStreamClientUploadContext).streamId
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${streamId}`,
            {
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
              },
            },
          )

          if (!response.ok) {
            throw new Error(`获取视频信息失败: ${response.status} ${response.statusText}`)
          }

          const result = await response.json()

          if (debug) {
            console.log('从 Cloudflare Stream 获取的视频信息:', result)
          }

          // 将 API 返回的数据映射到 cloudflareStream 结构
          const videoData = result.result || result
          const videoStatus: VideoStatus =
            videoData.status?.state === 'ready'
              ? 'ready'
              : videoData.status?.state === 'error'
                ? 'error'
                : 'processing'

          // 更新 data.cloudflareStream 字段
          data.cloudflareStream = {
            streamId: streamId,
            streamUrl: videoData.preview || `${options.streamDomain}/${streamId}/watch`,
            status: videoStatus,
            uploadedAt: new Date(
              videoData.uploaded || videoData.created || new Date().toISOString(),
            ),
            size: videoData.size,
            duration: videoData.duration,
            thumbnailUrl: videoData.thumbnail,
          }

          if (options.afterUpload) {
            await options.afterUpload({
              collection,
              data: data as CloudflareStreamFileData,
              file,
              req: {} as PayloadRequest,
              streamId: streamId,
              streamUrl: data.cloudflareStream.streamUrl,
            })
          }

          if (debug) {
            console.log('视频上传处理完成，更新的数据:', data.cloudflareStream)
          }
        } catch (error) {
          console.error('从 Cloudflare Stream 获取视频信息时出错:', error)

          // 设置默认的处理中状态
          data.cloudflareStream = {
            streamId: (clientUploadContext as CloudflareStreamClientUploadContext).streamId,
            streamUrl: `${options.streamDomain}/${(clientUploadContext as CloudflareStreamClientUploadContext).streamId}/watch`,
            status: 'processing',
            uploadedAt: new Date(),
          }
        }

        return data
      }) as HandleUpload,

      // 处理删除
      handleDelete: (async ({ doc }) => {
        const options = getOptions()

        try {
          const fileData = doc as CloudflareStreamFileData
          const streamId = fileData.cloudflareStream?.streamId

          if (!streamId) {
            if (options.debug) {
              console.warn(`删除操作: 文档没有关联的 streamId`)
            }
            return
          }

          // 删除 Cloudflare Stream 视频
          await handleStreamDelete({
            collection,
            doc,
            req: {} as PayloadRequest,
            streamId,
            options,
          })

          if (options.debug) {
            console.log('视频已从 Cloudflare Stream 成功删除:', streamId)
          }
        } catch (error) {
          console.error(`从 Cloudflare Stream 删除视频时出错:`, error)
        }
      }) as HandleDelete,

      // 静态文件处理器
      staticHandler: (async (req, { params }) => {
        const fakeMP4Content = new Uint8Array([
          0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00,
          0x00, 0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x08, 0x66, 0x72,
          0x65, 0x65, 0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74, 0x00, 0x00, 0x00, 0x00,
        ])

        // 返回伪造的MP4视频流，设置正确的 MIME 类型
        return new Response(fakeMP4Content, {
          status: 200,
          headers: {
            'Content-Type': 'video/mp4',
            'Cache-Control': 'max-age=3600',
          },
        })

        // const options = getOptions()
        // const streamDomain = options.streamDomain
        // try {
        //   // 从文档获取视频URL
        //   const { clientUploadContext } = params
        //   const { streamId } = clientUploadContext as { streamId: string }
        //   // 使用类型断言获取 collectionSlug
        //   const collectionSlug = params?.collection

        //   if (!collectionSlug) {
        //     return new Response('Collection not found', { status: 404 })
        //   }

        //   // 从 Cloudflare Stream 获取视频内容
        //   const streamUrl = `${streamDomain}/${streamId}/manifest/video.mp4`

        //   console.log('streamUrl', streamUrl)

        //   try {
        //     // 获取视频内容
        //     const videoResponse = await fetch(streamUrl)

        //     if (!videoResponse.ok) {
        //       console.error(
        //         `无法从 Cloudflare Stream 获取视频: ${videoResponse.status} ${videoResponse.statusText}`,
        //       )
        //       // 伪造一个简单的 MP4 视频内容
        //       // 创建一个最小的MP4文件二进制数据
        //       const fakeMP4Content = new Uint8Array([
        //         0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00,
        //         0x00, 0x00, 0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x08,
        //         0x66, 0x72, 0x65, 0x65, 0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74, 0x00, 0x00,
        //         0x00, 0x00,
        //       ])

        //       // 返回伪造的MP4视频流，设置正确的 MIME 类型
        //       return new Response(fakeMP4Content, {
        //         status: 200,
        //         headers: {
        //           'Content-Type': 'video/mp4',
        //           'Cache-Control': 'max-age=3600',
        //         },
        //       })
        //     }

        //     // 获取内容类型和其他头信息
        //     const headers = new Headers()

        //     // 设置内容类型，保证返回的是视频类型而不是文本
        //     // 根据 Cloudflare Stream 返回的是MP4流，设置合适的 MIME 类型
        //     headers.set('Content-Type', 'video/mp4')

        //     // 缓存控制
        //     headers.set('Cache-Control', 'max-age=3600')

        //     // 从 Cloudflare 响应中复制其他相关的头信息
        //     if (videoResponse.headers.has('Content-Length')) {
        //       headers.set('Content-Length', videoResponse.headers.get('Content-Length')!)
        //     }

        //     if (videoResponse.headers.has('ETag')) {
        //       headers.set('ETag', videoResponse.headers.get('ETag')!)
        //     }

        //     // 获取响应体作为 arrayBuffer
        //     const videoBuffer = await videoResponse.arrayBuffer()

        //     // 返回视频内容，使用正确的 headers
        //     return new Response(videoBuffer, {
        //       status: 200,
        //       headers,
        //     })
        //   } catch (fetchError) {
        //     console.error('获取 Cloudflare Stream 视频时出错:', fetchError)

        //     // 如果获取失败，作为备选方案使用重定向
        //     if (options.debug) {
        //       console.log('使用重定向作为备选方案:', streamUrl)
        //     }

        //     // 设置视频 MIME 类型的 headers
        //     const redirectHeaders = new Headers()
        //     redirectHeaders.set('Content-Type', 'video/mp4')

        //     return Response.redirect(streamUrl, 302)
        //   }
        // } catch (error) {
        //   console.error('Error serving Cloudflare Stream video:', error)
        //   return new Response('Internal Server Error', { status: 500 })
        // }
      }) as StaticHandler,

      // 生成 URL
      generateURL: ({ filename, data, collection }) => {
        // 获取插件选项
        const options = getOptions()
        const streamDomain = options.streamDomain

        // 如果提供了 streamDomain 并且 data 中包含 cloudflareStream 数据
        if (streamDomain && data && data.cloudflareStream?.streamId) {
          return `${streamDomain}/${data.cloudflareStream.streamId}/watch`
        }

        // 默认返回 API 路径
        return `/api/${collection.slug}/cloudflare-stream/${filename}`
      },
    }

    return adapter
  }
}

/**
 * Cloudflare Stream 插件
 */
export const cloudflareStreamPlugin = (pluginOptions: CloudflareStreamPluginConfig): Plugin => {
  return (incomingConfig: Config): Config => {
    // 创建配置的副本
    let config = { ...incomingConfig }

    const {
      collections = {},
      debug = false,
      enabled = true,
      enableClientUploads = false,
      disableLocalStorage = true,
    } = pluginOptions

    // 如果插件禁用，直接返回原配置
    if (!enabled) {
      return config
    }

    // 验证 Cloudflare 凭证
    const accountId = pluginOptions.accountId
    const apiToken = pluginOptions.apiToken

    if (!accountId || !apiToken) {
      console.error('Cloudflare Stream 插件: 缺少必要的凭证，请提供 accountId 和 apiToken')
      return config
    }

    // 创建插件选项的获取函数
    const getOptions = (): CloudflareStreamPluginOptions => ({
      debug,
      enabled,
      accountId,
      apiToken,
      collections: Object.keys(collections),
      enableClientUploads,
      clientUploads: pluginOptions.clientUploads,
      afterUpload: pluginOptions.afterUpload,
      beforeDelete: pluginOptions.beforeDelete,
      videoOptions: pluginOptions.videoOptions,
      streamDomain: pluginOptions.streamDomain,
    })

    // 创建适配器
    const adapter = cloudflareStreamAdapter(getOptions)

    // 给每个集合添加适配器
    const collectionsWithAdapter: CloudStoragePluginOptions['collections'] = Object.entries(
      collections,
    ).reduce(
      (acc, [slug, collOptions]) => ({
        ...acc,
        [slug]: {
          ...(collOptions === true ? {} : collOptions),
          adapter,
          disableLocalStorage,
        },
      }),
      {} as Record<string, CollectionOptions>,
    )

    // 实现 afterChangeHook
    const createAfterChangeHook = (collectionSlug: string): CollectionAfterChangeHook => {
      return async ({ doc, req, operation }) => {
        // 只处理包含 cloudflareStream 且状态为 processing 的文档
        if (doc?.cloudflareStream?.streamId && doc.cloudflareStream.status === 'processing') {
          const streamId = doc.cloudflareStream.streamId
          const options = getOptions()

          if (options.debug) {
            console.log(`开始轮询检查视频状态: ${streamId}`)
          }

          // 启动轮询检查
          const checkStatus = async () => {
            try {
              const result = await checkVideoStatus({
                streamId,
                options,
              })

              // 如果状态已改变，更新文档
              if (result.status !== 'processing') {
                if (options.debug) {
                  console.log(`视频状态已更新为 ${result.status}: ${streamId}`)
                }

                await req.payload.update({
                  collection: collectionSlug,
                  id: doc.id,
                  data: {
                    cloudflareStream: {
                      ...doc.cloudflareStream,
                      status: result.status,
                      duration: result.duration,
                      thumbnailUrl: result.thumbnailUrl,
                      size: result.size,
                    },
                  },
                })
                return true // 状态已更新，停止轮询
              }
              return false // 继续轮询
            } catch (error) {
              console.error(`检查视频状态时出错:`, error)
              return true // 出错时停止轮询
            }
          }

          // 执行轮询
          const poll = async () => {
            let attempts = 0
            const maxAttempts = 20 // 最多尝试20次
            const interval = 5000 // 每5秒检查一次

            const timer = setInterval(async () => {
              attempts++
              const shouldStop = await checkStatus()

              if (shouldStop || attempts >= maxAttempts) {
                clearInterval(timer)
                if (options.debug && attempts >= maxAttempts) {
                  console.log(`视频状态检查已达到最大尝试次数: ${streamId}`)
                }
              }
            }, interval)

            // 确保在 Node.js 进程退出前清理定时器
            process.on('beforeExit', () => {
              clearInterval(timer)
            })
          }

          // 开始轮询
          poll()
        }

        return doc
      }
    }

    // 客户端上传配置
    if (enableClientUploads) {
      initClientUploads({
        clientHandler: 'payloadcms-plugin-cloudflare-stream/client#CloudflareClientUploadHandler',
        collections,
        config,
        enabled: true,
        serverHandler: getGenerateSignedURLHandler({
          access:
            typeof pluginOptions.clientUploads === 'object'
              ? pluginOptions.clientUploads.access
              : undefined,
          accountId,
          apiToken,
          collections,
          videoOptions: pluginOptions.videoOptions,
        }),
        serverHandlerPath: '/cloudflare-stream-generate-signed-url',
      })
    }

    // 设置集合的上传参数
    config = {
      ...config,
      collections: (config.collections || []).map((collection) => {
        if (!collectionsWithAdapter[collection.slug]) {
          return collection
        }

        // 创建该集合的 afterChangeHook
        const afterChangeHook = createAfterChangeHook(collection.slug)

        return {
          ...collection,
          upload: {
            ...(typeof collection.upload === 'object' ? collection.upload : {}),
            disableLocalStorage,
            mimeTypes: ['video/*'],
          },
          hooks: {
            ...(collection.hooks || {}),
            afterChange: [...(collection.hooks?.afterChange || []), afterChangeHook],
          },
        }
      }),
    }

    // 使用 cloudStoragePlugin 包裹配置
    return cloudStoragePlugin({
      collections: collectionsWithAdapter,
    })(config)
  }
}

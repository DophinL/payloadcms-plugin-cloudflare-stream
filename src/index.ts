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

import { checkVideoStatus, genAndGetDownloadUrl, handleStreamDelete } from './handlers'
import type {
  CloudflareStreamPluginOptions,
  VideoStatus,
  File,
  ClientUploadCallbacks,
} from './types'
import { getGenerateSignedURLHandler } from './generateSignedURL'

// 客户端上传上下文类型定义
interface CloudflareStreamClientUploadContext {
  streamId: string
  [key: string]: any
}

interface CloudflareApiResponse {
  success?: boolean
  errors?: Array<{ message?: string }>
  result?: {
    uploadURL?: string
    uid?: string
  }
}

function toCloudflareErrorMessage(payload: CloudflareApiResponse | null): string {
  if (!payload) return 'Unknown Cloudflare API error'
  if (payload.errors?.length) {
    return payload.errors.map((error) => error.message || 'Unknown error').join(', ')
  }
  return 'Unknown Cloudflare API error'
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

async function ensureStreamIdForServerUpload({
  data,
  file,
  options,
  clientUploadContext,
}: {
  data: Record<string, any>
  file: CloudStorageFile
  options: CloudflareStreamPluginOptions
  clientUploadContext?: unknown
}): Promise<string | undefined> {
  const contextStreamId = (clientUploadContext as CloudflareStreamClientUploadContext | undefined)
    ?.streamId

  if (contextStreamId) {
    return contextStreamId
  }

  const { accountId, apiToken, debug } = options

  if (!file?.buffer) {
    if (debug) {
      console.warn('客户端上传上下文中缺少 streamId，且当前 file 无 buffer，无法执行服务端兜底上传')
    }
    return undefined
  }

  if (debug) {
    console.log('未提供 streamId，开始执行服务端兜底上传到 Cloudflare Stream')
  }

  let createPayload: CloudflareApiResponse | null = null
  const createResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        maxDurationSeconds: options.videoOptions?.maxDurationSeconds || 3600,
      }),
    },
  )

  const createText = await createResponse.text()
  try {
    createPayload = createText ? (JSON.parse(createText) as CloudflareApiResponse) : null
  } catch {
    createPayload = null
  }

  if (!createResponse.ok || !createPayload?.success || !createPayload.result?.uploadURL || !createPayload.result?.uid) {
    throw new Error(
      `Failed to create Stream upload URL: ${createResponse.status} ${createResponse.statusText}; ${toCloudflareErrorMessage(createPayload)}`,
    )
  }

  const streamId = createPayload.result.uid
  const uploadUrl = createPayload.result.uploadURL

  const formData = new FormData()
  const buffer = file.buffer as Buffer
  const blob = new Blob([bufferToArrayBuffer(buffer)], {
    type: file.mimeType || 'video/mp4',
  })
  const filename = file.filename || data?.filename || 'upload.mp4'
  formData.append('file', blob, filename)

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
  })

  if (!uploadResponse.ok) {
    const uploadText = await uploadResponse.text().catch(() => '')
    throw new Error(
      `Failed to upload video to Stream: ${uploadResponse.status} ${uploadResponse.statusText}${uploadText ? `; ${uploadText.slice(0, 500)}` : ''}`,
    )
  }

  if (debug) {
    console.log('服务端兜底上传完成', {
      streamId,
      filename,
      filesize: buffer.length,
    })
  }

  return streamId
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
    downloadUrl?: string
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
   * 客户端上传阶段的回调
   */
  clientCallbacks?: ClientUploadCallbacks

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
      {
        name: 'downloadUrl',
        label: '下载 URL',
        type: 'text',
        admin: {
          readOnly: true,
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
        console.log('handleUpload', data, file, clientUploadContext)
        const options = getOptions()
        const { accountId, apiToken, debug } = options

        let streamId: string | undefined

        try {
          streamId = await ensureStreamIdForServerUpload({
            data: data as Record<string, any>,
            file,
            options,
            clientUploadContext,
          })
        } catch (error) {
          console.error('服务端兜底上传失败:', error)
          return data
        }

        if (!streamId) {
          return data
        }

        try {
          // 请求 Cloudflare Stream API 获取视频详细信息
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

          // 从 Cloudflare 元数据中提取文件名（如果存在）
          const meta = videoData.meta || {}
          if (meta.name && !data.filename) {
            data.filename = meta.name
            if (debug) {
              console.log('从 Cloudflare 元数据中获取文件名:', meta.name)
            }
          }

          const videoUrl = await genAndGetDownloadUrl({
            streamId,
            options,
            waitUntilReady: false, // 不等待视频处理完成，避免阻塞 handleUpload
          })

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
            downloadUrl: videoUrl,
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
            streamId,
            streamUrl: `${options.streamDomain}/${streamId}/watch`,
            status: 'processing',
            uploadedAt: new Date(),
          }
        }

        return data
      }) as HandleUpload,

      // 处理删除
      // 如果写了删除逻辑，会导致 streamId 丢失，后续无法正常更新
      handleDelete: (async ({ doc, req }) => {
        console.log('handleDelete with no action', doc, req)
        // debugger
        // const options = getOptions()

        // try {
        //   const fileData = doc as CloudflareStreamFileData
        //   const streamId = fileData.cloudflareStream?.streamId

        //   if (!streamId) {
        //     if (options.debug) {
        //       console.warn(`删除操作: 文档没有关联的 streamId`)
        //     }
        //     return
        //   }

        //   // 删除 Cloudflare Stream 视频
        //   await handleStreamDelete({
        //     collection,
        //     doc,
        //     req: {} as PayloadRequest,
        //     streamId,
        //     options,
        //   })

        //   if (options.debug) {
        //     console.log('视频已从 Cloudflare Stream 成功删除:', streamId)
        //   }
        // } catch (error) {
        //   console.error(`从 Cloudflare Stream 删除视频时出错:`, error)
        // }
      }) as HandleDelete,

      // 静态文件处理器
      staticHandler: (async (req, { params, doc }) => {
        console.log('staticHandler', req, params, doc)

        debugger
        const options = getOptions()
        try {
          // 从参数中获取文件名和集合名称
          const { collection: collectionSlug, filename, clientUploadContext } = params

          if (!collectionSlug || !filename) {
            return new Response('必须提供集合和文件名', { status: 400 })
          }

          let streamId: string | undefined

          // 首先尝试从doc中获取streamId (安全类型检查)

          // 如果doc中没有，但有clientUploadContext，从中获取streamId
          if (
            clientUploadContext &&
            (clientUploadContext as CloudflareStreamClientUploadContext).streamId
          ) {
            streamId = (clientUploadContext as CloudflareStreamClientUploadContext).streamId
          }
          // 否则尝试从文件名中提取ID，然后查询文档
          else {
            // 从数据库查询文档
            if (doc) {
              const fetchedDoc = await req.payload.findByID({
                collection: collectionSlug as CollectionSlug,
                id: doc.id,
              })

              if (fetchedDoc) {
                // 安全检查获取streamId
                const fetchedFileData = fetchedDoc as any
                if (fetchedFileData?.cloudflareStream?.streamId) {
                  streamId = fetchedFileData.cloudflareStream.streamId
                }
              }
            }
          }

          if (!streamId) {
            return new Response('找不到视频ID', { status: 404 })
          }

          // 首先获取下载链接
          let videoUrl = await genAndGetDownloadUrl({
            streamId,
            options,
          })

          // 检查请求头中是否有ETag
          const etagFromHeaders = req.headers.get('etag') || req.headers.get('if-none-match')

          // 获取视频内容
          try {
            // 准备请求头
            const requestHeaders = new Headers()
            if (etagFromHeaders) {
              requestHeaders.set('If-None-Match', etagFromHeaders)
            }

            const videoResponse = await fetch(videoUrl, {
              headers: requestHeaders,
            })

            console.log(
              'videoResponse!!!',
              videoResponse.ok,
              videoResponse.status,
              videoResponse.statusText,
            )

            // 如果返回304 Not Modified，直接返回相同状态
            if (videoResponse.status === 304) {
              return new Response(null, {
                status: 304,
                headers: new Headers({
                  'Content-Type': videoResponse.headers.get('Content-Type') || 'video/mp4',
                  ETag: videoResponse.headers.get('ETag') || '',
                  'Cache-Control': 'max-age=3600',
                }),
              })
            }

            if (!videoResponse.ok) {
              if (options.debug) {
                console.error(`获取视频失败: ${videoResponse.status} ${videoResponse.statusText}`)
              }
              return new Response('无法获取视频内容', { status: videoResponse.status })
            }

            // 获取视频内容
            const videoBuffer = await videoResponse.arrayBuffer()

            // 设置响应头
            const headers = new Headers()
            headers.set('Content-Type', videoResponse.headers.get('Content-Type') || 'video/mp4')
            headers.set('Cache-Control', 'max-age=3600')

            // 复制重要的头信息
            const headersToForward = [
              'Content-Length',
              'ETag',
              'Last-Modified',
              'Accept-Ranges',
              'Content-Disposition',
            ]

            for (const header of headersToForward) {
              if (videoResponse.headers.has(header)) {
                headers.set(header, videoResponse.headers.get(header)!)
              }
            }

            console.log('headers!!!', headers)

            // 返回视频内容
            return new Response(videoBuffer, {
              status: 200,
              headers,
            })
          } catch (fetchError) {
            if (options.debug) {
              console.error('获取视频内容失败:', fetchError)
            }
            // 如果获取失败，重定向到视频URL
            return Response.redirect(videoUrl, 302)
          }
        } catch (error) {
          if (options.debug) {
            console.error('处理视频请求出错:', error)
          }
          return new Response('服务器内部错误', { status: 500 })
        }
      }) as StaticHandler,

      // 生成 URL，务必返回原始视频，否则在更新时会报错
      generateURL: ({ filename, data, collection }) => {
        // 获取插件选项
        const options = getOptions()
        const streamDomain = options.streamDomain

        if (data.cloudflareStream?.downloadUrl) {
          return data.cloudflareStream.downloadUrl
        }

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

                // 获取下载链接（如果视频已就绪）
                let downloadUrl = doc.cloudflareStream.downloadUrl || ''
                if (result.status === 'ready') {
                  try {
                    downloadUrl = await genAndGetDownloadUrl({
                      streamId,
                      options,
                      waitUntilReady: true, // 视频已就绪，可以等待下载链接
                    })
                  } catch (error) {
                    if (options.debug) {
                      console.error('获取下载链接失败:', error)
                    }
                  }
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
                      downloadUrl: downloadUrl,
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
        extraClientHandlerProps: () => ({
          callbacks: pluginOptions.clientCallbacks,
        }),
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
            // 不设置 mimeTypes，因为客户端上传时会导致验证错误
            // 客户端会在上传前验证文件类型
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

export type {
  ClientUploadCallbacks,
  ClientUploadErrorArgs,
  ClientUploadErrorStage,
  ClientUploadProgressArgs,
  ClientUploadSuccessArgs,
  UploadType,
} from './types'

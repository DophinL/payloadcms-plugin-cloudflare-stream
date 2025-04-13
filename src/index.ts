import type { CollectionSlug, Config } from 'payload'
import type {
  CollectionConfig,
  Field,
  CollectionBeforeChangeHook,
  CollectionAfterChangeHook,
  CollectionBeforeDeleteHook,
  PayloadRequest,
} from 'payload'
import type { ClientUploadsConfig } from '@payloadcms/plugin-cloud-storage/types'
import { initClientUploads } from '@payloadcms/plugin-cloud-storage/utilities'

import { checkVideoStatus, handleStreamDelete, handleStreamUpload } from './handlers'
import type { CloudflareStreamPluginOptions, VideoStatus } from './types'
import { getGenerateSignedURLHandler } from './generateSignedURL'

export type CloudflareStreamPluginConfig = {
  /**
   * List of collections to add a custom field
   */
  collections?: Partial<Record<CollectionSlug, true>>
  disabled?: boolean
}

/**
 * 创建一个字段配置，用于存储 Cloudflare Stream 相关信息
 */
const createStreamFields = (): Field[] => {
  return [
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
}

// 定义扩展的 PayloadRequest，包含上传文件信息
interface RequestWithFile extends PayloadRequest {
  file?: {
    data: Buffer
    mimetype: string
    name: string
    size: number
    tempFilePath?: string
  }
}

/**
 * Cloudflare Stream 插件
 */
export const cloudflareStreamPlugin = (pluginOptions: CloudflareStreamPluginOptions = {}) => {
  return (incomingConfig: Config): Config => {
    // 创建配置的副本
    const config = { ...incomingConfig }

    const { collections = [], debug = false, enabled = true } = pluginOptions

    // 如果插件禁用，直接返回原配置
    if (!enabled) {
      return config
    }

    // 检查是否有集合需要处理
    if (collections.length === 0) {
      if (debug) {
        console.warn('Cloudflare Stream 插件: 未指定任何集合，插件将不会生效')
      }
      return config
    }

    // 验证 Cloudflare 凭证
    const accountId = pluginOptions.accountId || process.env.CLOUDFLARE_ACCOUNT_ID
    const apiToken = pluginOptions.apiToken || process.env.CLOUDFLARE_API_TOKEN

    if (!accountId || !apiToken) {
      console.error('Cloudflare Stream 插件: 缺少必要的凭证，请提供 accountId 和 apiToken')
      return config
    }

    // 客户端上传配置
    if (pluginOptions.enableClientUploads) {
      initClientUploads({
        clientHandler: 'payloadcms-plugin-cloudflare-stream/client#CloudflareClientUploadHandler',
        collections: collections.reduce(
          (acc: Record<string, boolean>, slug: string) => ({ ...acc, [slug]: true }),
          {},
        ),
        config,
        enabled: true,
        serverHandler: getGenerateSignedURLHandler({
          access:
            typeof pluginOptions.clientUploads === 'object'
              ? pluginOptions.clientUploads.access
              : undefined,
          accountId,
          apiToken,
          collections: collections.reduce(
            (acc: Record<string, boolean>, slug: string) => ({ ...acc, [slug]: true }),
            {},
          ),
          videoOptions: pluginOptions.videoOptions,
        }),
        serverHandlerPath: '/cloudflare-stream-generate-signed-url',
      })
    }

    // 修改集合配置
    if (config.collections) {
      config.collections = config.collections.map((collection) => {
        // 如果集合在指定列表中
        if (collections.includes(collection.slug as CollectionSlug)) {
          // 设置上传配置
          collection.upload = {
            ...(typeof collection.upload === 'object' ? collection.upload : {}),
            disableLocalStorage: true,
            mimeTypes: ['video/*'],
          }

          // 添加字段
          const streamFields = createStreamFields()
          if (!collection.fields) collection.fields = []
          collection.fields = [...collection.fields, ...streamFields]

          // 添加钩子
          const beforeChangeHook: CollectionBeforeChangeHook = async ({ data, req, operation }) => {
            // 获取文件
            const reqWithFile = req as unknown as RequestWithFile
            const file = reqWithFile.file

            // 将 PayloadRequest.file 转换为插件所需的 File 格式
            const uploadFile = file
              ? {
                  buffer: file.data,
                  filename: file.name,
                  filesize: file.size,
                  mimeType: file.mimetype,
                  tempFilePath: file.tempFilePath,
                }
              : undefined

            // 仅在有文件上传时处理
            if (uploadFile && (operation === 'create' || operation === 'update')) {
              try {
                // 如果是更新操作且已有streamId，需要删除旧视频
                if (operation === 'update' && data.cloudflareStream?.streamId) {
                  const oldStreamId = data.cloudflareStream.streamId
                  try {
                    await handleStreamDelete({
                      collection,
                      doc: data,
                      req,
                      streamId: oldStreamId,
                      options: pluginOptions,
                    })
                    if (debug) {
                      console.log(`已删除旧视频: ${oldStreamId}`)
                    }
                  } catch (error) {
                    console.error(`删除旧视频时出错: ${oldStreamId}`, error)
                    // 继续上传新视频，不中断流程
                  }
                }

                // 上传到 Cloudflare Stream
                const { streamId, streamUrl, size, duration, thumbnailUrl, status } =
                  await handleStreamUpload({
                    collection,
                    data,
                    file: uploadFile,
                    req,
                    options: pluginOptions,
                  })

                // 更新数据，添加 Cloudflare Stream 信息
                const now = new Date()

                data.cloudflareStream = {
                  streamId,
                  streamUrl,
                  status: status,
                  uploadedAt: now,
                  size,
                  duration,
                  thumbnailUrl,
                }

                // 调用自定义的上传后钩子
                if (pluginOptions.afterUpload) {
                  await pluginOptions.afterUpload({
                    collection,
                    data,
                    file: uploadFile,
                    req,
                    streamId,
                    streamUrl,
                  })
                }
              } catch (error) {
                data.cloudflareStream = {
                  ...(data.cloudflareStream || {}),
                  status: 'error',
                }
                console.error(`Cloudflare Stream 上传错误:`, error)
                throw error
              }
            } else if (operation === 'update' && !uploadFile && data.cloudflareStream) {
              console.log('updateeeeee', (req as any).params?.id)
              // 更新操作但没有新文件上传，保留现有的cloudflareStream数据
              const existingDoc = await req.payload.findByID({
                collection: collection.slug,
                // FIXME
                id: (req as any).params?.id,
                // id: req.params?.id,
              })

              if (existingDoc.cloudflareStream) {
                data.cloudflareStream = existingDoc.cloudflareStream
              }
            }

            return data
          }

          const afterChangeHook: CollectionAfterChangeHook = async ({ doc, req, operation }) => {
            // 只处理包含 cloudflareStream 且状态为 processing 的文档
            if (doc?.cloudflareStream?.streamId && doc.cloudflareStream.status === 'processing') {
              const streamId = doc.cloudflareStream.streamId

              // 启动轮询检查
              const checkStatus = async () => {
                try {
                  const result = await checkVideoStatus({
                    streamId,
                    options: pluginOptions,
                  })

                  // 如果状态已改变，更新文档
                  if (result.status !== 'processing') {
                    await req.payload.update({
                      collection: collection.slug as CollectionSlug,
                      id: doc.id,
                      data: {
                        cloudflareStream: {
                          ...doc.cloudflareStream,
                          status: result.status,
                          duration: result.duration || doc.cloudflareStream.duration,
                          thumbnailUrl: result.thumbnailUrl || doc.cloudflareStream.thumbnailUrl,
                          size: result.size || doc.cloudflareStream.size,
                        },
                      },
                    })
                  }
                } catch (error) {
                  console.error(`检查视频状态时出错:`, error)
                }
              }

              // 定义轮询函数
              const poll = async () => {
                let attempts = 0
                const maxAttempts = 20 // 最多尝试20次
                const interval = 10000 // 10秒间隔

                const checkLoop = async () => {
                  if (attempts >= maxAttempts) return
                  attempts++

                  await checkStatus()

                  // 如果仍在处理中，继续轮询
                  if (attempts < maxAttempts) {
                    setTimeout(checkLoop, interval)
                  }
                }

                await checkLoop()
              }

              // 启动轮询
              poll()
            }
          }

          const beforeDeleteHook: CollectionBeforeDeleteHook = async ({ req, id }) => {
            try {
              // 查找文档以获取 streamId
              const doc = await req.payload.findByID({
                collection: collection.slug,
                id,
              })

              const streamId = doc?.cloudflareStream?.streamId

              if (!streamId) {
                if (debug) {
                  console.warn(`删除操作: 文档 ${id} 没有关联的 streamId`)
                }
                return
              }

              // 调用自定义的删除前钩子
              if (pluginOptions.beforeDelete) {
                await pluginOptions.beforeDelete({
                  collection,
                  doc,
                  req,
                  streamId,
                })
              }

              // 删除 Cloudflare Stream 视频
              await handleStreamDelete({
                collection,
                doc,
                req,
                streamId,
                options: pluginOptions,
              })
            } catch (error) {
              console.error(`删除视频时出错:`, error)
              // 不抛出错误，让删除操作继续
            }
          }

          // 添加钩子到集合
          collection.hooks = {
            ...(collection.hooks || {}),
            beforeChange: [...(collection.hooks?.beforeChange || []), beforeChangeHook],
            afterChange: [...(collection.hooks?.afterChange || []), afterChangeHook],
            beforeDelete: [...(collection.hooks?.beforeDelete || []), beforeDeleteHook],
          }
        }

        return collection
      })
    }

    return config
  }
}

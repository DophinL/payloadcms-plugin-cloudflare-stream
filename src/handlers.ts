import type { CollectionConfig, PayloadRequest } from 'payload'
import type {
  CloudflareStreamPluginOptions,
  File,
  HandleStreamDelete,
  HandleStreamUpload,
  VideoStatus,
} from './types.js'

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts'

/**
 * 上传视频到 Cloudflare Stream
 */
export const handleStreamUpload: HandleStreamUpload = async ({
  collection,
  data,
  file,
  req,
  options,
}) => {
  try {
    const { debug = false, videoOptions = {} } = options

    // 获取 Cloudflare 凭证
    const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID
    const apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN

    if (!accountId || !apiToken) {
      throw new Error('缺少 Cloudflare 凭证，请提供 accountId 和 apiToken')
    }

    // 准备 Buffer
    let buffer: Buffer
    if (file.buffer) {
      buffer = file.buffer
    } else if (file.tempFilePath) {
      const fs = await import('fs')
      buffer = fs.readFileSync(file.tempFilePath)
    } else {
      throw new Error('无法获取文件内容')
    }

    // 准备上传参数
    const uploadParams: Record<string, any> = {
      allowedOrigins: ['*'],
      requireSignedURLs: videoOptions.requireSignedURLs || false,
    }

    if (videoOptions.maxDurationSeconds) {
      uploadParams.maxDurationSeconds = videoOptions.maxDurationSeconds
    }

    if (videoOptions.allowDownload !== undefined) {
      uploadParams.allowDownload = videoOptions.allowDownload
    }

    if (videoOptions.watermark) {
      uploadParams.watermark = videoOptions.watermark
    }

    // 发送请求到 Cloudflare API
    const response = await fetch(`${API_BASE}/${accountId}/stream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      // 使用 FormData 发送文件
      body: (() => {
        const formData = new FormData()
        formData.append('file', new Blob([buffer], { type: file.mimeType }), file.filename)

        // 添加上传参数
        Object.entries(uploadParams).forEach(([key, value]) => {
          formData.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
        })

        return formData
      })(),
    })

    if (!response.ok) {
      const errorData = await response.json()
      if (debug) {
        console.error('Cloudflare Stream 上传失败:', errorData)
      }
      throw new Error(`上传到 Cloudflare Stream 失败: ${response.status} ${response.statusText}`)
    }

    const result = await response.json()

    if (!result.success) {
      if (debug) {
        console.error('Cloudflare Stream 上传失败:', result)
      }
      throw new Error(
        `上传到 Cloudflare Stream 失败: ${result.errors?.map((e: { message: string }) => e.message).join(', ')}`,
      )
    }

    const streamId = result.result.uid
    const streamUrl = result.result.playback.hls
    const size = result.result.size || file.filesize
    const duration = result.result.duration || 0
    const thumbnailUrl = result.result.thumbnail || ''
    const status: VideoStatus =
      result.result.status.state === 'ready'
        ? 'ready'
        : result.result.status.state === 'error'
          ? 'error'
          : 'processing'

    if (debug) {
      console.log('视频已成功上传到 Cloudflare Stream:', result.result)
    }

    return { streamId, streamUrl, size, duration, thumbnailUrl, status }
  } catch (error) {
    console.error(`上传视频到 Cloudflare Stream 时出错:`, error)
    throw error
  }
}

/**
 * 从 Cloudflare Stream 删除视频
 */
export const handleStreamDelete: HandleStreamDelete = async ({
  collection,
  doc,
  req,
  streamId,
  options,
}) => {
  try {
    const { debug = false } = options

    // 获取 Cloudflare 凭证
    const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID
    const apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN

    if (!accountId || !apiToken) {
      throw new Error('缺少 Cloudflare 凭证，请提供 accountId 和 apiToken')
    }

    if (!streamId) {
      if (debug) {
        console.warn('无法删除视频：未提供 streamId')
      }
      return
    }

    // 发送请求到 Cloudflare API
    const response = await fetch(`${API_BASE}/${accountId}/stream/${streamId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    })

    if (!response.ok) {
      // 如果视频已经不存在，不视为错误
      if (response.status === 404) {
        if (debug) {
          console.warn(`视频已不存在，无需删除: ${streamId}`)
        }
        return
      }

      const errorData = await response.json()
      if (debug) {
        console.error('Cloudflare Stream 删除失败:', errorData)
      }
      throw new Error(`从 Cloudflare Stream 删除失败: ${response.status} ${response.statusText}`)
    }

    if (debug) {
      console.log('视频已从 Cloudflare Stream 成功删除:', streamId)
    }
  } catch (error) {
    console.error(`从 Cloudflare Stream 删除视频时出错:`, error)
    throw error
  }
}

/**
 * 检查视频状态
 */
export const checkVideoStatus = async ({
  streamId,
  options,
}: {
  streamId: string
  options: CloudflareStreamPluginOptions
}): Promise<{
  status: VideoStatus
  duration?: number
  thumbnailUrl?: string
  size?: number
}> => {
  const { debug = false } = options

  // 获取 Cloudflare 凭证
  const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !apiToken) {
    throw new Error('缺少 Cloudflare 凭证，请提供 accountId 和 apiToken')
  }

  try {
    // 获取视频信息
    const response = await fetch(`${API_BASE}/${accountId}/stream/${streamId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      if (debug) {
        console.error(`获取视频状态失败: ${response.status} ${response.statusText}`)
      }
      throw new Error(`获取视频状态失败: ${response.status} ${response.statusText}`)
    }

    const result = await response.json()

    if (!result.success) {
      if (debug) {
        console.error('获取视频状态失败:', result)
      }
      throw new Error(
        `获取视频状态失败: ${result.errors?.map((e: { message: string }) => e.message).join(', ')}`,
      )
    }

    const videoData = result.result

    // 返回视频状态和信息
    return {
      status:
        videoData.status.state === 'ready'
          ? 'ready'
          : videoData.status.state === 'error'
            ? 'error'
            : 'processing',
      duration: videoData.duration || undefined,
      thumbnailUrl: videoData.thumbnail || undefined,
      size: videoData.size || undefined,
    }
  } catch (error) {
    console.error(`检查视频状态时出错:`, error)
    throw error
  }
}

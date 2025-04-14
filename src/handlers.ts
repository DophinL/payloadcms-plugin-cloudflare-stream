import type { CollectionConfig, PayloadRequest } from 'payload'
import type { CloudflareStreamPluginOptions, File, HandleStreamDelete, VideoStatus } from './types'
import { poll } from './utils'

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts'

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
 * @param options.waitUntilReady 是否等待视频处理完成
 */
export const checkVideoStatus = async ({
  streamId,
  options,
  waitUntilReady = false,
}: {
  streamId: string
  options: CloudflareStreamPluginOptions
  waitUntilReady?: boolean
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

  const fetchVideoStatus = async (): Promise<{
    status: VideoStatus
    duration?: number
    thumbnailUrl?: string
    size?: number
  }> => {
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
    const status: VideoStatus =
      videoData.status.state === 'ready'
        ? 'ready'
        : videoData.status.state === 'error'
          ? 'error'
          : 'processing'

    return {
      status,
      duration: videoData.duration || undefined,
      thumbnailUrl: videoData.thumbnail || undefined,
      size: videoData.size || undefined,
    }
  }

  try {
    // 如果不需要等待视频处理完成，直接返回当前状态
    if (!waitUntilReady) {
      return await fetchVideoStatus()
    }

    // 使用轮询等待视频处理完成
    return await poll(
      async () => {
        const status = await fetchVideoStatus()

        if (status.status === 'ready') {
          return { success: true, result: status }
        } else if (status.status === 'error') {
          throw new Error('视频处理失败')
        }

        // 继续轮询
        return { success: false, result: status }
      },
      {
        interval: 5000,
        maxAttempts: 12,
        onProgress: (attempt, maxAttempts) => {
          if (debug) {
            console.log(`等待视频处理完成，尝试次数: ${attempt}/${maxAttempts}`)
          }
        },
      },
    )
  } catch (error) {
    console.error(`检查视频状态时出错:`, error)
    throw error
  }
}

/**
 * 获取 cloudflare stream 的下载 url
 * 先检查视频状态，确保为 ready 状态后再生成下载链接
 * @param param0
 */
export const genAndGetDownloadUrl = async ({
  streamId,
  options,
}: {
  streamId: string
  options: CloudflareStreamPluginOptions
}): Promise<string> => {
  const { debug = false } = options

  // 获取 Cloudflare 凭证
  const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !apiToken) {
    throw new Error('缺少 Cloudflare 凭证，请提供 accountId 和 apiToken')
  }

  try {
    // 先检查视频状态，waitUntilReady 设为 true 表示等待视频处理完成
    const videoStatus = await checkVideoStatus({ streamId, options, waitUntilReady: true })

    if (debug) {
      console.log('视频状态检查通过，开始生成下载链接', streamId)
    }

    // 调用 POST 请求创建下载链接
    const postResponse = await fetch(`${API_BASE}/${accountId}/stream/${streamId}/downloads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!postResponse.ok) {
      if (debug) {
        console.error(`创建下载链接失败: ${postResponse.status} ${postResponse.statusText}`)
      }
      throw new Error(`创建下载链接失败: ${postResponse.status} ${postResponse.statusText}`)
    }

    const postResult = await postResponse.json()

    if (!postResult.success) {
      if (debug) {
        console.error('创建下载链接失败:', postResult)
      }
      throw new Error(
        `创建下载链接失败: ${postResult.errors?.map((e: { message: string }) => e.message).join(', ')}`,
      )
    }

    // 检查是否已经准备好
    if (postResult.result.default.status === 'ready') {
      return postResult.result.default.url
    }

    // 使用 poll 函数轮询下载状态
    return await poll<string>(
      async () => {
        const getResponse = await fetch(`${API_BASE}/${accountId}/stream/${streamId}/downloads`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
        })

        if (!getResponse.ok) {
          return { success: false, result: '' }
        }

        const getResult = await getResponse.json()

        if (getResult.success && getResult.result.default.status === 'ready') {
          return { success: true, result: getResult.result.default.url }
        }

        // 未就绪，返回失败
        return { success: false, result: '' }
      },
      {
        interval: 5000,
        maxAttempts: 12,
        onProgress: (attempt, maxAttempts) => {
          if (debug) {
            console.log(`检查下载链接状态中，尝试次数: ${attempt}/${maxAttempts}`)
          }
        },
      },
    )
  } catch (error) {
    console.error('获取下载链接时出错:', error)
    throw error
  }
}

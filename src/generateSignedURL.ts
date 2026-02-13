import type { ClientUploadsAccess } from '@payloadcms/plugin-cloud-storage/types'
import type { PayloadHandler, PayloadRequest } from 'payload'
import { APIError, Forbidden } from 'payload'

interface Args {
  access?: ClientUploadsAccess
  accountId: string
  apiToken: string
  collections: Record<string, any>
  videoOptions?: any
}

const defaultAccess: Args['access'] = ({ req }: { req: PayloadRequest }) => !!req.user

export const getGenerateSignedURLHandler = ({
  access = defaultAccess,
  accountId,
  apiToken,
  collections,
  videoOptions = {},
}: Args): PayloadHandler => {
  return async (req) => {
    if (!req.json) {
      throw new APIError('Content-Type expected to be application/json', 400)
    }

    const { collectionSlug, filename, mimeType } = await req.json()

    if (!collections[collectionSlug]) {
      throw new APIError(`Collection ${collectionSlug} was not found in Cloudflare Stream options`)
    }

    if (!(await access({ collectionSlug, req }))) {
      throw new Forbidden()
    }

    try {
      const allowedOrigins = normalizeAllowedOrigins(videoOptions.allowedOrigins)

      // 判断文件是基础上传还是需要TUS分片上传
      const isTusUpload = req.headers.get('X-Use-Tus') === 'true'

      // 如果是TUS上传请求，使用不同的端点和头部
      if (isTusUpload) {
        // TUS上传 - 获取可恢复的上传URL
        const tusResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream?direct_user=true`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiToken}`,
              'Tus-Resumable': '1.0.0',
              'Upload-Length': req.headers.get('Upload-Length') || '',
              'Upload-Metadata': buildUploadMetadata(filename, mimeType, videoOptions),
            },
          },
        )

        if (!tusResponse.ok) {
          throw new APIError(
            `Failed to generate TUS upload URL: ${tusResponse.status} ${tusResponse.statusText}`,
          )
        }

        // TUS上传URL在Location头部中
        const tusUploadURL = tusResponse.headers.get('Location')
        if (!tusUploadURL) {
          throw new APIError('Failed to get TUS upload URL from Cloudflare response')
        }

        // 从URL中提取streamId
        const streamId = extractStreamIdFromTusUrl(tusUploadURL)
        if (!streamId) {
          throw new APIError('Failed to parse streamId from TUS upload URL')
        }

        // TUS 分片上传时，创建 stream 后补写 allowedOrigins
        if (allowedOrigins && allowedOrigins.length > 0) {
          await setAllowedOriginsForStream({
            accountId,
            apiToken,
            streamId,
            allowedOrigins,
          })
        }

        return Response.json({
          tusEndpoint: tusUploadURL,
          streamId,
        })
      } else {
        // 常规上传（200MB以下的文件）
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              maxDurationSeconds: videoOptions.maxDurationSeconds || 3600, // 默认一小时
              allowedOrigins,
            }),
          },
        )

        if (!response.ok) {
          throw new APIError(
            `Failed to generate upload URL: ${response.status} ${response.statusText}`,
          )
        }

        const result = await response.json()

        if (!result.success) {
          throw new APIError(
            `Failed to generate upload URL: ${result.errors?.map((e: { message: string }) => e.message).join(', ')}`,
          )
        }

        return Response.json({
          uploadURL: result.result.uploadURL,
          streamId: result.result.uid,
        })
      }
    } catch (error: unknown) {
      console.error('Error generating Cloudflare Stream upload URL:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new APIError(`Failed to generate upload URL: ${errorMessage}`)
    }
  }
}

/**
 * 从TUS上传URL中提取streamId
 */
function extractStreamIdFromTusUrl(tusUrl: string): string {
  // Cloudflare TUS URL 格式: https://upload.cloudflarestream.com/tus/{streamId}?tusv2=true
  const matches = tusUrl.match(/\/tus\/([a-f0-9]{32})(?:\?|$)/)
  return matches ? matches[1] : ''
}

function normalizeAllowedOrigins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const seen = new Set<string>()
  const result: string[] = []

  for (const origin of value) {
    const normalized = sanitizeAllowedOrigin(String(origin || ''))
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result.length > 0 ? result : undefined
}

function sanitizeAllowedOrigin(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      return parsed.host.trim().toLowerCase() || null
    } catch {
      return null
    }
  }

  const withoutPath = raw.split('/')[0]?.trim()
  if (!withoutPath) return null
  return withoutPath.toLowerCase()
}

async function setAllowedOriginsForStream({
  accountId,
  apiToken,
  streamId,
  allowedOrigins,
}: {
  accountId: string
  apiToken: string
  streamId: string
  allowedOrigins: string[]
}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${streamId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ allowedOrigins }),
  })

  const text = await response.text()
  let payload: { success?: boolean; errors?: Array<{ message?: string }> } | null = null

  try {
    payload = text ? (JSON.parse(text) as { success?: boolean; errors?: Array<{ message?: string }> }) : null
  } catch {
    payload = null
  }

  if (!response.ok || !payload?.success) {
    const details = payload?.errors?.map((item) => item.message || 'unknown').join(', ') || text
    throw new APIError(
      `Failed to set allowedOrigins for stream ${streamId}: ${response.status} ${response.statusText}${details ? `; ${details}` : ''}`,
    )
  }
}

/**
 * 构建TUS上传元数据头
 */
function buildUploadMetadata(filename: string, mimeType: string, videoOptions: any): string {
  const metadata = []

  // 添加文件名 - Cloudflare 使用 'name' 字段而不是 'filename'
  if (filename) {
    metadata.push(`name ${Buffer.from(filename).toString('base64')}`)
  }

  if (mimeType) {
    metadata.push(`filetype ${Buffer.from(mimeType).toString('base64')}`)
  }

  // 添加最大持续时间
  if (videoOptions.maxDurationSeconds) {
    metadata.push(
      `maxDurationSeconds ${Buffer.from(videoOptions.maxDurationSeconds.toString()).toString('base64')}`,
    )
  }

  // 添加其他可能的元数据
  if (videoOptions.requireSignedURLs) {
    metadata.push('requiresignedurls')
  }

  // 添加 allowDownload 选项
  if (videoOptions.allowDownload !== undefined) {
    metadata.push(
      `allowDownload ${Buffer.from(String(videoOptions.allowDownload)).toString('base64')}`,
    )
  }

  return metadata.join(',')
}

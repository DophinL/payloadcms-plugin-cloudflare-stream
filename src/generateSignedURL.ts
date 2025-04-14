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

/**
 * 构建TUS上传元数据头
 */
function buildUploadMetadata(filename: string, mimeType: string, videoOptions: any): string {
  const metadata = []

  // 添加文件名和类型
  if (filename) {
    metadata.push(`filename ${Buffer.from(filename).toString('base64')}`)
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

  return metadata.join(',')
}

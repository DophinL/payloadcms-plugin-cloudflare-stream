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
      // 创建一个一次性上传URL
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
    } catch (error: unknown) {
      console.error('Error generating Cloudflare Stream upload URL:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new APIError(`Failed to generate upload URL: ${errorMessage}`)
    }
  }
}

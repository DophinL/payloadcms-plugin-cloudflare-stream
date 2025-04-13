'use client'
import { createClientUploadHandler } from '@payloadcms/plugin-cloud-storage/client'

export const CloudflareClientUploadHandler = createClientUploadHandler({
  handler: async ({
    apiRoute,
    collectionSlug,
    file,
    serverHandlerPath,
    serverURL,
    updateFilename,
  }) => {
    try {
      // 获取上传URL
      const response = await fetch(`${serverURL}${apiRoute}${serverHandlerPath}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          collectionSlug,
          filename: file.name,
          mimeType: file.type,
        }),
      })

      if (!response.ok) {
        throw new Error(`获取上传URL失败: ${response.status} ${response.statusText}`)
      }

      const { uploadURL, streamId } = await response.json()

      // 上传到Cloudflare
      const formData = new FormData()
      formData.append('file', file)

      const uploadResponse = await fetch(uploadURL, {
        method: 'POST',
        body: formData,
      })

      if (!uploadResponse.ok) {
        throw new Error(`上传视频失败: ${uploadResponse.status} ${uploadResponse.statusText}`)
      }

      // const streamResult = await uploadResponse.json()

      // 如果需要更新文件名（一般不需要）
      if (updateFilename) {
        updateFilename(file.name)
      }

      // 返回cloudflare stream信息
      return {
        streamId,
        status: 'processing',
      }
    } catch (error) {
      console.error('Cloudflare Stream客户端上传失败:', error)
      throw error
    }
  },
})

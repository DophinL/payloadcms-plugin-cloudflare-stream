'use client'
import { createClientUploadHandler } from '@payloadcms/plugin-cloud-storage/client'
import * as tus from 'tus-js-client'

// 200MB 的字节大小
const MAX_FILE_SIZE = 200 * 1024 * 1024

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
      // 判断是否需要使用TUS进行分片上传
      const useTus = file.size > MAX_FILE_SIZE

      // 第一步：获取上传URL（根据文件大小决定上传方式）
      const response = await fetch(`${serverURL}${apiRoute}${serverHandlerPath}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          // 如果需要TUS上传，添加标记头
          ...(useTus ? { 'X-Use-Tus': 'true', 'Upload-Length': file.size.toString() } : {}),
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

      const responseData = await response.json()

      console.log('responseData!!!', responseData)

      // 根据上传方式处理
      if (useTus && responseData.tusEndpoint) {
        // TUS分片上传（大文件）
        console.log(
          '使用TUS上传大文件:',
          file.name,
          '大小:',
          (file.size / (1024 * 1024)).toFixed(2),
          'MB',
        )

        return new Promise((resolve, reject) => {
          // 创建TUS上传实例
          const upload = new tus.Upload(file, {
            endpoint: responseData.tusEndpoint,
            retryDelays: [0, 3000, 5000, 10000, 20000],
            chunkSize: 50 * 1024 * 1024, // 设置块大小为50MB
            metadata: {
              filename: file.name,
              filetype: file.type,
            },
            // 错误处理
            onError: (error) => {
              console.error('Cloudflare Stream TUS上传失败:', error)
              reject(error)
            },
            // 成功回调
            onSuccess: () => {
              console.log('Cloudflare Stream TUS上传成功')

              // 更新文件名（如果需要）
              if (updateFilename) {
                updateFilename(file.name)
              }

              // 返回视频信息
              resolve({
                streamId: responseData.streamId,
                status: 'processing',
              })
            },
            // 进度回调
            onProgress: (bytesUploaded, bytesTotal) => {
              const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2)
              console.log(
                `上传进度: ${percentage}%，已上传: ${formatBytes(bytesUploaded)}/${formatBytes(bytesTotal)}`,
              )
            },
          })

          // 开始上传
          upload.start()
        })
      } else if (responseData.uploadURL) {
        // 常规上传（小文件）
        console.log(
          '使用常规方式上传小文件:',
          file.name,
          '大小:',
          (file.size / (1024 * 1024)).toFixed(2),
          'MB',
        )

        const formData = new FormData()
        formData.append('file', file)

        const uploadResponse = await fetch(responseData.uploadURL, {
          method: 'POST',
          body: formData,
        })

        if (!uploadResponse.ok) {
          throw new Error(`上传视频失败: ${uploadResponse.status} ${uploadResponse.statusText}`)
        }

        // 更新文件名（如果需要）
        if (updateFilename) {
          updateFilename(file.name)
        }

        // 返回视频信息
        return {
          streamId: responseData.streamId,
          status: 'processing',
        }
      } else {
        throw new Error('服务器未返回有效的上传端点')
      }
    } catch (error) {
      console.error('Cloudflare Stream客户端上传失败:', error)
      throw error
    }
  },
})

/**
 * 格式化字节大小为人类可读形式
 */
function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

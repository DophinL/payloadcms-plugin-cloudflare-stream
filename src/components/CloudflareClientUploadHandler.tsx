'use client'
import { createClientUploadHandler } from '@payloadcms/plugin-cloud-storage/client'
import { toast } from '@payloadcms/ui'
import * as tus from 'tus-js-client'
import type { ClientUploadCallbacks, ClientUploadErrorStage, UploadType } from '../types'

// 200MB 的字节大小
const MAX_FILE_SIZE = 200 * 1024 * 1024

type HandlerExtraProps = {
  callbacks?: ClientUploadCallbacks
}

export const CloudflareClientUploadHandler = createClientUploadHandler<HandlerExtraProps>({
  handler: async ({
    apiRoute,
    collectionSlug,
    file,
    extra,
    serverHandlerPath,
    serverURL,
    updateFilename,
  }) => {
    // 判断是否需要使用TUS进行分片上传
    const useTus = file.size > MAX_FILE_SIZE
    const uploadType: UploadType = useTus ? 'tus' : 'direct'
    const callbacks = extra?.callbacks
    let toastId: string | number | undefined
    let uploadSessionEstablished = false
    let errorNotified = false

    const describeUpload = () =>
      `${file.name || '未命名视频'} · ${uploadType === 'tus' ? '分片上传' : '直传'}`

    const showLoadingToast = (message: string, description?: string) => {
      toastId = toast.loading(message, {
        description: description ?? describeUpload(),
        duration: Infinity,
        id: toastId,
      })
    }

    const showSuccessToast = (message: string, description?: string) => {
      toastId = toast.success(message, {
        description: description ?? describeUpload(),
        id: toastId,
      })
      toastId = undefined
    }

    const showErrorToast = (message: string, description?: string) => {
      toastId = toast.error(message, {
        description,
        id: toastId,
      })
      toastId = undefined
    }

    const emitError = (error: unknown, stage: ClientUploadErrorStage = 'upload') => {
      errorNotified = true

      const normalizedError = error instanceof Error ? error : new Error(String(error))
      callbacks?.onError?.({
        collectionSlug,
        error: normalizedError,
        file,
        stage,
        uploadType,
      })
      showErrorToast('上传失败', normalizedError.message)
    }

    const emitSuccess = (streamId: string) => {
      callbacks?.onSuccess?.({
        collectionSlug,
        file,
        streamId,
        uploadType,
      })
      showSuccessToast('上传完成')
    }

    const emitProgress = (bytesUploaded: number, bytesTotal: number) => {
      const normalizedTotal = bytesTotal || file.size || 1
      const percentage = Number(((bytesUploaded / normalizedTotal) * 100).toFixed(2))

      callbacks?.onProgress?.({
        bytesUploaded,
        bytesTotal: normalizedTotal,
        collectionSlug,
        file,
        percentage,
        uploadType,
      })

      showLoadingToast('正在上传视频', `${describeUpload()} · ${percentage.toFixed(2)}%`)

      return percentage
    }

    try {
      showLoadingToast('正在准备上传')
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
      uploadSessionEstablished = true

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
              emitError(error)
              reject(error)
            },
            // 成功回调
            onSuccess: () => {
              console.log('Cloudflare Stream TUS上传成功')
              emitSuccess(responseData.streamId)

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
              const percentage = emitProgress(bytesUploaded, bytesTotal)
              console.log(
                `上传进度: ${percentage.toFixed(2)}%，已上传: ${formatBytes(bytesUploaded)}/${formatBytes(bytesTotal)}`,
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

        try {
          await uploadFileWithProgress({
            file,
            uploadURL: responseData.uploadURL,
            onProgress: (uploaded, total) => {
              const percentage = emitProgress(uploaded, total)
              console.log(
                `上传进度: ${percentage.toFixed(2)}%，已上传: ${formatBytes(uploaded)}/${formatBytes(total)}`,
              )
            },
          })
        } catch (error) {
          emitError(error)
          throw error
        }

        // 更新文件名（如果需要）
        if (updateFilename) {
          updateFilename(file.name)
        }

        emitSuccess(responseData.streamId)

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
      if (!errorNotified) {
        emitError(error, uploadSessionEstablished ? 'upload' : 'generate-upload-url')
      }
      throw error
    }
  },
})

/**
 * 使用 XMLHttpRequest 上传文件以便能够获取上传进度
 */
function uploadFileWithProgress({
  file,
  uploadURL,
  onProgress,
}: {
  file: File
  uploadURL: string
  onProgress: (uploaded: number, total: number) => void
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', uploadURL)

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size
      onProgress(event.loaded, total || file.size)
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`上传视频失败: ${xhr.status} ${xhr.statusText}`))
      }
    }

    xhr.onerror = () => {
      reject(new Error('上传过程中发生网络错误'))
    }

    const formData = new FormData()
    formData.append('file', file)
    xhr.send(formData)
  })
}

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

/**
 * 通用轮询方法
 * @param callback 每次轮询调用的回调函数，返回值为 true 表示轮询成功，轮询结束
 * @param options 轮询配置
 * @returns 返回最后一次成功回调的结果
 */
export const poll = async <T>(
  callback: () => Promise<{ success: boolean; result: T }>,
  options?: {
    interval?: number // 轮询间隔，默认 5000ms
    maxAttempts?: number // 最大尝试次数，默认 12 次
    onProgress?: (attempt: number, maxAttempts: number) => void // 进度回调
  },
): Promise<T> => {
  const interval = options?.interval || 5000 // 默认 5 秒
  const maxAttempts = options?.maxAttempts || 12 // 默认最多 12 次
  const onProgress = options?.onProgress

  let attempts = 0

  while (attempts < maxAttempts) {
    // 第一次尝试不等待
    if (attempts > 0) {
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    attempts++

    try {
      const { success, result } = await callback()

      // 如果有进度回调，调用进度回调
      if (onProgress) {
        onProgress(attempts, maxAttempts)
      }

      if (success) {
        return result
      }
    } catch (error) {
      // 回调执行出错，继续轮询
      console.warn(`轮询过程中出错 (${attempts}/${maxAttempts}):`, error)
    }
  }

  throw new Error(`轮询超时，已达到最大尝试次数 ${maxAttempts}`)
}

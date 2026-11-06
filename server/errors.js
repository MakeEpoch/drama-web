export class AppError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}
export const fail = (code, message, status) => new AppError(code, message, status)
export function publicError(error) {
  // Never forward SDK/ffmpeg exception text: it can contain signed URLs or keys.
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: 'UPSTREAM_FAILED', message: '上游或媒体处理失败，请稍后重试' }
}
export function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw fail('INVALID_ID', '无效的内容编号', 400)
  }
  return value
}

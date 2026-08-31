/**
 * Lightweight, zero-dependency sliding window rate limiter for production security.
 * Prevents brute-force attacks on sensitive endpoints (e.g. login, forgot-password).
 */

const hitMap = new Map()

// Clean up expired buckets every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, record] of hitMap.entries()) {
    if (now > record.resetTime) {
      hitMap.delete(key)
    }
  }
}, 5 * 60 * 1000)

export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 20, message = 'Too many requests, please try again later.' }) {
  return function rateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown-ip'
    const key = `${req.path}:${ip}`
    const now = Date.now()

    let record = hitMap.get(key)
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs }
      hitMap.set(key, record)
      return next()
    }

    record.count += 1
    if (record.count > max) {
      return res.status(429).json({ error: message })
    }

    next()
  }
}

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max 15 login/reset attempts per window
  message: 'Too many authentication attempts. Please wait 15 minutes before trying again.',
})

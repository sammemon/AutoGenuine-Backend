// Terminal request logger with ANSI color formatting
// Shows incoming API calls, status codes, latency, and success/failure state

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  bgGreen: '\x1b[42m\x1b[30m',
  bgYellow: '\x1b[43m\x1b[30m',
  bgRed: '\x1b[41m\x1b[37m',
  bgBlue: '\x1b[44m\x1b[37m',
  bgMagenta: '\x1b[45m\x1b[37m',
}

const METHOD_COLORS = {
  GET: COLORS.cyan,
  POST: COLORS.green,
  PUT: COLORS.yellow,
  PATCH: COLORS.magenta,
  DELETE: COLORS.red,
}

export function requestLogger(req, res, next) {
  // Skip noisy static assets if desired, or log everything
  const start = performance.now()
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false })
  const method = req.method
  const url = req.originalUrl || req.url

  // Hook into response finish
  res.on('finish', () => {
    const duration = Math.round(performance.now() - start)
    const status = res.statusCode

    let statusColor = COLORS.green
    let statusIcon = '✓ SUCCESS'

    if (status >= 500) {
      statusColor = COLORS.red
      statusIcon = '✗ SERVER ERROR'
    } else if (status >= 400) {
      statusColor = COLORS.yellow
      statusIcon = '⚠ CLIENT REJECTED'
    } else if (status >= 300) {
      statusColor = COLORS.cyan
      statusIcon = '➜ REDIRECT'
    }

    const methodColor = METHOD_COLORS[method] || COLORS.bold
    const durationStr = `${duration}ms`.padStart(6)

    console.log(
      `${COLORS.dim}[${timestamp}]${COLORS.reset} ` +
      `${methodColor}${method.padEnd(6)}${COLORS.reset} ` +
      `${url.padEnd(32)} ` +
      `${statusColor}${status} ${statusIcon}${COLORS.reset} ` +
      `${COLORS.dim}(${durationStr})${COLORS.reset}`
    )
  })

  next()
}

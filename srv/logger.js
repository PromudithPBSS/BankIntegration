const fs = require('fs')
const path = require('path')

const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(__dirname, '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'bank-integration.log')

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function stringifyArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg, null, 2)
    } catch (err) {
      return String(arg)
    }
  }
  return String(arg)
}

function write(level, args) {
  const timestamp = new Date().toISOString()
  const message = args.map(stringifyArg).join(' ')
  const line = `[${timestamp}] [${level}] ${message}`

  if (level === 'ERROR' || level === 'WARN') {
    console.error(line)
  } else {
    console.log(line)
  }

  try {
    ensureLogDir()
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (err) {
    console.error(`Failed to write to log file (${LOG_FILE}):`, err.message)
  }
}

module.exports = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  debug: (...args) => write('DEBUG', args),
  LOG_FILE
}

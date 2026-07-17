const fs = require('fs')
const path = require('path')

const DB_FILE = process.env.PROCESSED_DB_PATH
  ? path.resolve(process.env.PROCESSED_DB_PATH)
  : path.join(__dirname, '..', 'db', 'processed-transactions.json')

function ensureDbFile() {
  const dir = path.dirname(DB_FILE)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ processed: {} }, null, 2))
  }
}

function readDb() {
  ensureDbFile()
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8')
    const parsed = JSON.parse(raw || '{}')
    if (!parsed.processed || typeof parsed.processed !== 'object') {
      parsed.processed = {}
    }
    return parsed
  } catch (err) {
    // Corrupt or unreadable file - start fresh rather than crashing the worker
    return { processed: {} }
  }
}

function writeDb(data) {
  ensureDbFile()
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

/**
 * Returns true if the given transaction id has already been
 * successfully processed (i.e. sent to the bank).
 */
function isProcessed(id) {
  if (!id) return false
  const db = readDb()
  return Boolean(db.processed[id])
}

/**
 * Records a transaction id as processed, along with the payload sent
 * and the bank's response, so it survives app restarts.
 */
function markProcessed(id, record = {}) {
  if (!id) return
  const db = readDb()
  db.processed[id] = {
    ...record,
    processedAt: new Date().toISOString()
  }
  writeDb(db)
}

function getAllProcessed() {
  return readDb().processed
}

module.exports = { isProcessed, markProcessed, getAllProcessed, DB_FILE }

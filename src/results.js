/**
 * Reads and appends the experiment log.
 *
 * results.tsv is HARNESS-OWNED and lives inside the repository so a human can
 * read it in the morning. It is a log, not part of the metric: nothing here
 * feeds a verdict.
 */
import { appendFile, readFile, stat } from 'node:fs/promises'

/** Log location, relative to the repository root. */
export const RESULTS_PATH = 'results.tsv'

/**
 * The first line of every log file. Column order must be kept in step with
 * COLUMNS, formatRow and parseRow.
 */
export const HEADER = 'commit\tscore\tbest_bench_delta\tbytes_delta\tstatus\tdescription'

const COLUMN_COUNT = 6

/**
 * The longest description written verbatim. `-desc` has no length cap of its
 * own, and an agent pasting something large (a stack trace, a diff) would
 * otherwise produce a line long enough to break every future load — after
 * which `report` fails on the whole file, not just that line, until a human
 * edits it by hand.
 */
export const MAX_DESCRIPTION_LEN = 256

/**
 * Appends one row, creating the file with a header when needed.
 *
 * @param {string} path
 * @param {{commit: string, score: number, bestBenchDelta: number, bytesDelta: number, status: string, description: string}} row
 */
export async function appendRow(path, row) {
  const exists = await stat(path).then(
    () => true,
    () => false,
  )
  const line = [
    clean(row.commit),
    format(row.score, 4),
    format(row.bestBenchDelta, 2),
    format(row.bytesDelta, 2),
    clean(row.status),
    truncate(clean(row.description)),
  ].join('\t')
  await appendFile(path, `${exists ? '' : `${HEADER}\n`}${line}\n`, 'utf8')
}

/**
 * Reads every row written by appendRow. A missing file is not an error — it
 * is a run that has not recorded an experiment yet.
 *
 * @param {string} path
 * @returns {Promise<object[]>}
 */
export async function loadRows(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw new Error(`read ${path}: ${err.message}`, { cause: err })
  }

  const rows = []
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue
    if (i === 0 && line === HEADER) continue
    rows.push(parseRow(path, i + 1, line))
  }
  return rows
}

function parseRow(path, lineNo, line) {
  const parts = line.split('\t')
  if (parts.length !== COLUMN_COUNT) {
    throw new Error(`${path}:${lineNo}: expected ${COLUMN_COUNT} columns, got ${parts.length}`)
  }
  return {
    commit: parts[0],
    score: number(path, lineNo, 'score', parts[1]),
    bestBenchDelta: number(path, lineNo, 'best_bench_delta', parts[2]),
    bytesDelta: number(path, lineNo, 'bytes_delta', parts[3]),
    status: parts[4],
    description: parts[5],
  }
}

function number(path, lineNo, field, text) {
  const n = Number(text)
  if (text.trim() === '' || Number.isNaN(n)) {
    throw new Error(`${path}:${lineNo}: ${field} ${JSON.stringify(text)} is not a number`)
  }
  return n
}

/** Makes a field safe for a tab-separated single-line record. */
function clean(s) {
  return String(s ?? '')
    .replace(/[\t\r\n]/g, ' ')
    .trim()
}

/**
 * Caps s at MAX_DESCRIPTION_LEN characters. Counting characters rather than
 * bytes means a multi-byte character is never split in half.
 */
function truncate(s) {
  const chars = [...s]
  return chars.length <= MAX_DESCRIPTION_LEN ? s : `${chars.slice(0, MAX_DESCRIPTION_LEN).join('')}...`
}

/**
 * Formats a number with fixed precision. A non-finite value (a gate failure
 * has no score) is written as zero rather than "NaN", which loadRows would
 * refuse to read back.
 */
function format(n, digits) {
  return (Number.isFinite(n) ? n : 0).toFixed(digits)
}

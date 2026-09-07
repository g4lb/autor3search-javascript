/**
 * Persists a run's reference points OUT-OF-TREE from the repository being
 * optimized.
 *
 * None of this may live inside the repository. The agent edits the
 * repository, so in-tree state would be silently writable by the very agent
 * it constrains: it could rewrite a frozen golden copy, drop a key from the
 * manifest, or — worst — edit the pinned baseline WORKTREE to make the
 * BASELINE slow, after which every candidate "improves" and every experiment
 * returns KEEP without optimizing anything.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Per-repository state directory name under the user cache. */
export const STATE_DIR_NAME = 'autor3search-javascript'

/** Environment variable relocating every run's out-of-tree state. */
export const STATE_HOME_ENV = 'AUTOR3SEARCH_JAVASCRIPT_STATE_HOME'

/** Paths within a run's state directory. */
export const BASELINE_FILE = 'baseline.json'
export const WORKTREE_NAME = 'baseline-worktree'

/** Run branches are named `<prefix><tag>`. */
export const BRANCH_PREFIX = 'autor3search-javascript/'

/**
 * The strict allow-list for a run tag: letters, digits, '.', '_' and '-'.
 *
 * Notably absent is '/' — or any other path separator — which alone blocks
 * both directory traversal ("../../etc") and an absolute path
 * ("/etc/passwd"), because a tag can then never be more than one path
 * segment. stateDir joins the tag into a filesystem path and callers mkdir
 * that path immediately, long before git's own ref-name rules would get a
 * chance to reject a bad tag.
 */
const VALID_TAG = /^[A-Za-z0-9._-]+$/

/**
 * Reports whether tag is safe to use as a filesystem path segment.
 *
 * "." and ".." are rejected even though both characters are individually
 * allowed: either one alone means "this directory" or "the parent directory"
 * rather than naming anything.
 *
 * @param {string} tag
 * @throws {Error}
 */
export function validTag(tag) {
  if (!tag) throw new Error('tag must not be empty')
  if (tag === '.' || tag === '..') {
    throw new Error(`tag ${JSON.stringify(tag)} is not allowed: it is a directory reference, not a run identifier`)
  }
  if (!VALID_TAG.test(tag)) {
    throw new Error(
      `tag ${JSON.stringify(tag)} is not allowed: tags may contain only letters, digits, '.', '_' and '-'`,
    )
  }
}

/**
 * The out-of-tree directory holding every piece of state the metric depends
 * on, for one repository and run tag.
 *
 * Keyed by a hash of the repository's real absolute path, so two checkouts of
 * the same project never share state and the same checkout reached by two
 * spellings resolves to one key.
 *
 * @param {string} repoRoot
 * @param {string} tag
 * @returns {Promise<string>}
 */
export async function stateDir(repoRoot, tag) {
  validTag(tag)
  let absolute = resolve(repoRoot)
  // Resolve symlinked ancestors (macOS's /tmp -> /private/tmp, for one) so the
  // same repository reached by two different spellings hashes the same. A
  // path that does not exist yet falls back to the unresolved form rather
  // than failing.
  absolute = await realpath(absolute).catch(() => absolute)
  const key = createHash('sha256').update(absolute).digest('hex').slice(0, 16)
  return join(await stateHome(), key, tag)
}

/**
 * The directory holding every repository's run state.
 *
 * A relative override is REFUSED rather than resolved. Joining one would
 * succeed, but the result would then depend on the working directory each
 * command was invoked from — so `eval` run from a subdirectory and `stop` run
 * from the repository root would address different state for the same run,
 * and the brake would silently miss.
 */
async function stateHome() {
  const override = process.env[STATE_HOME_ENV]
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${STATE_HOME_ENV} must be an absolute path, got ${JSON.stringify(override)}: a relative state ` +
          `home would resolve differently depending on where each command is run from`,
      )
    }
    return override
  }
  return join(userCacheDir(), STATE_DIR_NAME)
}

/** The conventional per-platform user cache directory. */
function userCacheDir() {
  if (process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME)) {
    return process.env.XDG_CACHE_HOME
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches')
  if (platform() === 'win32') return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(homedir(), '.cache')
}

/**
 * @typedef {object} Baseline
 * @property {string} tag human-chosen run identifier
 * @property {string} branch run branch checked out when the baseline was recorded
 * @property {string} commit the FROZEN anchor — never changes after `baseline` records it
 * @property {string} measureCommit the ADVANCING pointer the pinned worktree tracks
 * @property {string} createdAt ISO-8601, UTC
 * @property {string[]} benchmarks the declared benchmark set
 * @property {string} pattern the name filter derived from benchmarks
 * @property {string} configSha256 hash of the in-repo config at baseline time
 */

/** Writes the baseline as indented JSON, creating parent directories. */
export async function saveBaseline(path, baseline) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

/**
 * Reads a baseline written by saveBaseline.
 *
 * A record written before measureCommit existed has no such field; it falls
 * back to commit — exactly the value a fresh baseline starts it at — rather
 * than staying undefined, which would fail the worktree integrity check on
 * the very first eval of an older run.
 *
 * @returns {Promise<Baseline>}
 */
export async function loadBaseline(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`no baseline at ${path}: run 'autor3search-javascript baseline' first`, { cause: err })
    }
    throw new Error(`read baseline ${path}: ${err.message}`, { cause: err })
  }
  let record
  try {
    record = JSON.parse(text)
  } catch (err) {
    throw new Error(`parse baseline ${path}: ${err.message}`, { cause: err })
  }
  if (!record.measureCommit) record.measureCommit = record.commit
  return record
}

/**
 * Builds a name filter matching exactly these benchmarks. An empty list
 * yields "." — every benchmark.
 *
 * Each name is regexp-escaped. Names found by src/discover.js need no
 * escaping, but `benchmarks:` in config.yaml is documented as hand-editable,
 * and a stray metacharacter in a hand-typed name would otherwise silently
 * BROADEN the pattern to match benchmarks nobody selected.
 *
 * @param {string[]} names
 * @returns {string}
 */
export function benchPattern(names) {
  if (names.length === 0) return '.'
  return `^(${names.map(escapeRegExp).join('|')})$`
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Snapshots test and benchmark files at baseline time and restores them
 * before every evaluation, so an agent cannot weaken its own success
 * criteria — or rewrite the benchmark that defines the metric.
 *
 * Every path constant here is relative to the run's OUT-OF-TREE state
 * directory, never to the repository root. The frozen store and its manifest
 * are part of what the score depends on, so they must live where the agent
 * being measured cannot reach them; a caller joining these onto the
 * repository root would silently reintroduce that hole.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, posix, isAbsolute } from 'node:path'

export const STORE_DIR = 'frozen'
export const MANIFEST_PATH = 'frozen/manifest.json'

/** `.code` on an error raised by a symlink anywhere along a frozen path. */
export const ERR_SYMLINK = 'A3S_SYMLINK'

/** `.code` on an error raised when a golden copy no longer matches its hash. */
export const ERR_STORE_TAMPERED = 'A3S_STORE_TAMPERED'

/**
 * `.code` on an error raised by a HARD link at a frozen path.
 *
 * A hard link defeats the symlink defence entirely: `lstat().isSymbolicLink()`
 * is false for one, so the path looks like an ordinary regular file. Writing
 * to it writes to every other name for that inode — so an agent can point a
 * frozen path at any file it may write and have `restore` clobber it with
 * test source. That is an uncontrolled write outside the repository, which is
 * exactly what this module exists to prevent.
 */
export const ERR_HARD_LINK = 'A3S_HARD_LINK'

/**
 * Copies each file into storeDir and records its hash.
 *
 * @param {string} repoRoot
 * @param {string} storeDir
 * @param {string[]} files repo-relative paths
 * @returns {Promise<{files: Record<string, string>}>}
 */
export async function snapshot(repoRoot, storeDir, files) {
  const manifest = { files: {} }
  for (const rel of [...files].sort()) {
    const src = safeJoin(repoRoot, rel, 'snapshot')
    await refuseSymlink(repoRoot, rel, 'snapshot', 'in the repository')
    // The store is harness-owned, but a directory left behind by an earlier
    // attempt under the same tag is not necessarily pristine: refuse to write
    // the golden copy through a link there either.
    await refuseSymlink(storeDir, rel, 'snapshot', 'inside the frozen store')

    const content = await readFile(src)
    const dst = safeJoin(storeDir, rel, 'snapshot')
    await mkdir(dirname(dst), { recursive: true })
    await refuseHardLink(dst, rel, 'snapshot', 'inside the frozen store')
    await writeFile(dst, content)
    manifest.files[rel] = hash(content)
  }
  return manifest
}

/**
 * Rewrites every frozen file in the working tree from the store, recreating
 * files the agent deleted. Returns the paths it changed, sorted.
 *
 * Both sides are checked against the hash recorded at baseline, and the
 * working tree is examined BEFORE the store is read. That ordering is what
 * makes the common case — an eval where the agent touched no frozen file —
 * cost one read per file instead of two: the destination already hashes to
 * the manifest value, so the golden copy is never opened at all.
 *
 * @returns {Promise<string[]>}
 */
export async function restore(repoRoot, storeDir, manifest) {
  const changed = []
  for (const rel of sortedPaths(manifest)) {
    // Before any read or write: readFile follows links exactly as writeFile
    // does, so this has to come first, or the check would read THROUGH a link
    // and conclude the file was fine.
    await refuseSymlink(repoRoot, rel, 'restore', 'in the repository')
    const dst = safeJoin(repoRoot, rel, 'restore')

    const current = await readFile(dst).catch(() => null)
    if (current && hash(current) === manifest.files[rel]) continue

    await refuseSymlink(storeDir, rel, 'restore', 'inside the frozen store')
    const src = safeJoin(storeDir, rel, 'restore')
    const golden = await readFile(src)
    const got = hash(golden)
    if (got !== manifest.files[rel]) {
      throw tagged(
        `restore ${rel}: frozen store copy does not match the hash recorded at baseline ` +
          `(store hashes to ${got}, manifest records ${manifest.files[rel]})`,
        ERR_STORE_TAMPERED,
      )
    }

    await mkdir(dirname(dst), { recursive: true })
    await refuseHardLink(dst, rel, 'restore', 'in the repository')
    await writeFile(dst, golden)
    changed.push(rel)
  }
  return changed
}

/**
 * Reports which frozen files currently differ from the baseline. A deleted
 * file counts as changed, and so does one reached through a symlink — that is
 * at least as suspicious as a deletion, and is reported rather than followed.
 *
 * @returns {Promise<string[]>}
 */
export async function verify(repoRoot, manifest) {
  const changed = []
  for (const rel of sortedPaths(manifest)) {
    const linked = await symlinkComponent(repoRoot, rel)
    if (linked) {
      changed.push(rel)
      continue
    }
    const content = await readFile(safeJoin(repoRoot, rel, 'verify')).catch(() => null)
    if (content === null || hash(content) !== manifest.files[rel]) changed.push(rel)
  }
  return changed
}

/** Writes the manifest as indented JSON. */
export async function saveManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Reads a manifest written by saveManifest. */
export async function loadManifest(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`read manifest ${path}: ${err.message}`, { cause: err })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`parse manifest ${path}: ${err.message}`, { cause: err })
  }
  return { files: parsed.files ?? {} }
}

const sortedPaths = (manifest) => Object.keys(manifest.files).sort()

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * Joins rel onto root, rejecting anything that would escape it. Manifest
 * entries come from a JSON file on disk, so they are untrusted input:
 * `restore` writes through them before every evaluation.
 */
function safeJoin(root, rel, op) {
  if (isAbsolute(rel)) throw new Error(`${op} ${rel}: frozen path must be relative`)
  const clean = posix.normalize(rel.split('\\').join('/'))
  if (clean === '..' || clean.startsWith('../')) {
    throw new Error(`${op} ${rel}: frozen path escapes the repository root`)
  }
  return join(root, clean)
}

/**
 * Throws when any component of rel, beneath root, is a symlink.
 *
 * Checking only the FINAL component is not enough, and that is the hole this
 * closes: readFile and writeFile resolve the whole path, so replacing a
 * parent DIRECTORY with a link redirects the write just as effectively as
 * replacing the file itself, landing the frozen content outside the
 * repository. An lstat on the file then reports a perfectly ordinary regular
 * file, because the link was already followed to get there.
 *
 * `root` itself is deliberately not examined: a repository legitimately
 * reached through a symlinked ancestor — macOS's /tmp, a home directory on a
 * linked volume — is not tampering, and refusing to work there would break
 * ordinary setups.
 */
async function refuseSymlink(root, rel, op, where) {
  const linked = await symlinkComponent(root, rel)
  if (!linked) return
  throw tagged(
    `${op} ${rel}: ${linked} is a symlink ${where}; refusing to read or write through it, ` +
      `which could reach a file outside the repository`,
    ERR_SYMLINK,
  )
}

/** The first component of rel, beneath root, that is a symlink — or null. */
async function symlinkComponent(root, rel) {
  const parts = posix.normalize(rel.split('\\').join('/')).split('/').filter((p) => p !== '' && p !== '.')
  let path = root
  for (const [i, part] of parts.entries()) {
    path = join(path, part)
    const stats = await lstat(path).catch(() => null)
    if (stats?.isSymbolicLink()) return parts.slice(0, i + 1).join('/')
  }
  return null
}

/**
 * Throws when the destination is a hard link — a file with more than one name.
 *
 * Checked immediately before every write, on both the working tree and the
 * store. A regular file in a checkout has exactly one link; more than one
 * means writing here also writes somewhere else, potentially outside the
 * repository. Only an existing regular file is examined: a path that does not
 * exist yet cannot be linked, and a directory's link count is unrelated.
 */
async function refuseHardLink(path, rel, op, where) {
  const stats = await lstat(path).catch(() => null)
  if (stats?.isFile() && stats.nlink > 1) {
    throw tagged(
      `${op} ${rel}: ${rel} has ${stats.nlink} names (a hard link) ${where}; refusing to write through ` +
        `it, because that would also overwrite the other name(s) for this file — possibly outside the ` +
        `repository. Replace it with a regular file and rerun.`,
      ERR_HARD_LINK,
    )
  }
}

/** Builds an Error carrying a stable `.code` the pipeline branches on. */
function tagged(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

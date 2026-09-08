/**
 * Creates the run branch, freezes the tests and benchmarks, and pins the
 * commit this run measures against.
 *
 * Everything it writes lands OUTSIDE the repository, under the run's state
 * directory — see src/state/index.js for why.
 */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CONFIG_PATH } from '../config.js'
import { baseNames, benchmarks, frozenFiles } from '../discover.js'
import * as freeze from '../freeze.js'
import * as gitx from '../gitx.js'
import { RESULTS_PATH, loadRows } from '../results.js'
import {
  BASELINE_FILE,
  BRANCH_PREFIX,
  WORKTREE_NAME,
  benchPattern,
  ensureSecureDir,
  linkNodeModules,
  saveBaseline,
  stateDir,
  validTag,
} from '../state/index.js'
import { expandSingleDashFlags, loadRepoConfig, resolveRepo } from './context.js'

export async function runBaseline(args, io) {
  const { values } = parseArgs({
    args: expandSingleDashFlags(args, ['tag']),
    options: {
      C: { type: 'string', default: '.' },
      tag: { type: 'string', default: defaultTag() },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  const tag = values.tag
  validTag(tag) // before the tag ever reaches a filesystem path
  const root = await resolveRepo(values.C)
  const cfg = await loadRepoConfig(root)

  if (!(await gitx.isClean(root))) {
    io.err.write(
      'the working tree has uncommitted changes.\n\n' +
        'baseline refuses a dirty tree because a baseline pinned against what is on disk, rather than\n' +
        'what is in git, would not be reproducible — the pinned worktree could never be recreated.\n' +
        'Commit or stash first.\n',
    )
    return 2
  }

  const rows = await loadRows(join(root, RESULTS_PATH))
  if (rows.length > 0 && !values.force) {
    io.err.write(
      `${RESULTS_PATH} already holds ${rows.length} experiment row(s) from an earlier run. Starting a new\n` +
        `baseline over them would mix two runs' results in one log. Move it aside, or pass --force to\n` +
        `start anyway.\n`,
    )
    return 2
  }

  const branch = `${BRANCH_PREFIX}${tag}`
  if (await gitx.branchExists(root, branch)) {
    io.err.write(
      `branch ${branch} already exists — that tag has been used, and a run's state directory is keyed\n` +
        `by tag, so reusing it would silently mix two runs' frozen copies and baseline records. Pick\n` +
        `another -tag.\n`,
    )
    return 2
  }

  const found = await benchmarks(root)
  if (found.length === 0) {
    io.err.write(`no benchmarks found in ${root}: run 'autor3search-javascript init' and read what it says\n`)
    return 2
  }

  const originalBranch = await gitx.currentBranch(root)
  await gitx.createBranch(root, branch)

  // From here on, any failure must undo the branch, or a retry under the same
  // tag is permanently blocked by a branch nothing finished creating.
  try {
    const dir = await ensureSecureDir(await stateDir(root, tag))

    const declared = cfg.benchmarks.length > 0 ? cfg.benchmarks : baseNames(found)
    const toFreeze = await frozenFiles(root, cfg.unfreeze)
    const manifest = await freeze.snapshot(root, join(dir, freeze.STORE_DIR), toFreeze)
    await freeze.saveManifest(join(dir, freeze.MANIFEST_PATH), manifest)

    const commit = await gitx.headCommit(root)
    const worktree = join(dir, WORKTREE_NAME)
    await rm(worktree, { recursive: true, force: true })
    await gitx.addWorktree(root, worktree, commit)
    // A worktree checks out only tracked files, and node_modules is normally
    // gitignored — link it in so the pinned baseline side can resolve the
    // bench runner at all. See linkNodeModules for why this lives here.
    await linkNodeModules(root, worktree)

    await saveBaseline(join(dir, BASELINE_FILE), {
      tag,
      branch,
      commit,
      measureCommit: commit,
      createdAt: new Date().toISOString(),
      benchmarks: declared,
      pattern: benchPattern(declared),
      configSha256: createHash('sha256').update(await readFile(join(root, CONFIG_PATH))).digest('hex'),
    })

    io.out.write(`run branch     ${branch}  (checked out)\n`)
    io.out.write(`baseline       ${commit}\n`)
    io.out.write(`benchmarks     ${declared.join(', ')}\n`)
    io.out.write(`frozen         ${toFreeze.length} test and bench file(s)\n`)
    io.out.write(`worktree       ${worktree}\n`)
    io.out.write(`\nstart the agent: point it at program.md\n`)
    io.out.write(`to stop the run: autor3search-javascript stop\n`)
    return 0
  } catch (err) {
    await gitx.checkout(root, originalBranch).catch(() => {})
    await gitx.deleteBranch(root, branch).catch(() => {})
    io.err.write(`baseline failed, run branch ${branch} removed: ${err.message}\n`)
    return 2
  }
}

/** Today as a short slug, e.g. "sep7" — the shape the README's examples use. */
function defaultTag() {
  const now = new Date()
  const month = now.toLocaleString('en-US', { month: 'short' }).toLowerCase()
  return `${month}${now.getDate()}`
}

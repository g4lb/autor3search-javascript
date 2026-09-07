/**
 * The git commands autor3search-javascript needs.
 *
 * Stdout and stderr are captured separately so that stderr chatter on an
 * otherwise successful command — git-lfs filter warnings, advice.* hints,
 * locale warnings, a user's own hooks — is never parsed as part of the
 * result. Stderr appears in the error message only when the command fails.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Runs a git subcommand in dir and returns its trimmed stdout. */
async function git(dir, ...args) {
  try {
    const { stdout } = await exec('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch (err) {
    const stderr = (err.stderr ?? '').trim()
    throw new Error(`git ${args.join(' ')}: ${err.message}${stderr ? `\n${stderr}` : ''}`, { cause: err })
  }
}

/** The repository root containing dir. */
export const root = (dir) => git(dir, 'rev-parse', '--show-toplevel')

/** The short hash of HEAD. */
export const headCommit = (dir) => git(dir, 'rev-parse', '--short=7', 'HEAD')

/**
 * The first line of HEAD's commit message. `stop --force` prints this to
 * identify the commit an abandoned experiment left behind, so only the
 * subject is wanted — never the body or its trailers.
 */
export const headSubject = (dir) => git(dir, 'log', '-1', '--format=%s')

/** The checked-out branch name. */
export const currentBranch = (dir) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')

/** Creates and checks out a branch at HEAD. */
export const createBranch = (dir, name) => git(dir, 'checkout', '-b', name).then(() => undefined)

/** Switches the working tree to an existing branch or other ref. */
export const checkout = (dir, ref) => git(dir, 'checkout', ref).then(() => undefined)

/**
 * Force-deletes a local branch. Used to undo a run branch left behind by a
 * `baseline` attempt that failed partway through, so a retry under the same
 * name is not permanently blocked.
 */
export const deleteBranch = (dir, name) => git(dir, 'branch', '-D', name).then(() => undefined)

/** Checks commit out into a detached worktree at path. */
export const addWorktree = (repoDir, path, commit) =>
  git(repoDir, 'worktree', 'add', '--detach', path, commit).then(() => undefined)

/**
 * Moves an existing worktree to commit, detached. Used to advance the pinned
 * baseline worktree after a KEEP: re-pointing an existing worktree with a
 * plain checkout has less failure surface than removing and re-adding it,
 * which would re-register it in the main repository's metadata rather than
 * just moving HEAD. -f discards stray changes in the target — nothing should
 * ever modify the pinned worktree, but checking out over a dirty tree without
 * it would fail instead of re-pointing.
 */
export const checkoutDetached = (dir, commit) =>
  git(dir, 'checkout', '-f', '--detach', commit).then(() => undefined)

/**
 * Deletes a worktree previously created by addWorktree.
 *
 * --force silently discards uncommitted and untracked changes in the target.
 * git still refuses to remove the main working tree or an unregistered path,
 * but callers must only ever point this at a worktree the harness itself
 * created — never at a path a human might have unsaved work in.
 */
export const removeWorktree = (repoDir, path) =>
  git(repoDir, 'worktree', 'remove', '--force', path).then(() => undefined)

/** Reports whether a local branch exists. */
export async function branchExists(dir, name) {
  try {
    await git(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`)
    return true
  } catch {
    return false
  }
}

/** Reports whether the working tree has no changes. */
export async function isClean(dir) {
  return (await git(dir, 'status', '--porcelain')) === ''
}

/**
 * Lists repo-relative paths modified since commit, including untracked files
 * that are not gitignored, sorted and deduplicated.
 *
 * Both git calls use -z. Without it, git quotes and octal-escapes any path
 * containing non-ASCII bytes, quotes or backslashes (e.g. "src/caf\303\251.js"),
 * which would then fail scope matching and let an out-of-scope edit through.
 * -z output is NUL-separated and not terminated, so it is split explicitly.
 */
export async function changedSince(dir, commit) {
  const tracked = await git(dir, 'diff', '--name-only', '-z', commit)
  const untracked = await git(dir, 'ls-files', '-z', '--others', '--exclude-standard')
  const seen = new Set()
  for (const block of [tracked, untracked]) {
    for (const entry of block.split('\0')) {
      if (entry !== '') seen.add(entry)
    }
  }
  return [...seen].sort()
}

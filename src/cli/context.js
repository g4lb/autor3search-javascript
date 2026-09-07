/**
 * Shared resolution for every command: which repository, which run.
 *
 * Nothing here calls process.chdir. `-C` is threaded through as a value
 * instead, which is safer under concurrent invocations and lets the tests
 * exercise commands without mutating global state.
 */
import { CONFIG_PATH, loadConfig } from '../config.js'
import * as gitx from '../gitx.js'
import { BRANCH_PREFIX, stateDir, validTag } from '../state/index.js'
import { join } from 'node:path'

/** The repository root containing dir. */
export async function resolveRepo(dir) {
  try {
    return await gitx.root(dir)
  } catch (err) {
    throw new Error(`${dir} is not inside a git repository: ${err.message}`, { cause: err })
  }
}

/**
 * Resolves the run a command should act on.
 *
 * The tag comes from `-tag` when given, otherwise from the checked-out branch
 * — which is why `status` and `stop` accept `-tag`: they are meant to work
 * from any branch, including one the agent is not on.
 *
 * @param {string} dir
 * @param {string} [tag]
 */
export async function resolveRun(dir, tag) {
  const root = await resolveRepo(dir)
  let resolved = tag
  if (!resolved) {
    const branch = await gitx.currentBranch(root)
    if (!branch.startsWith(BRANCH_PREFIX)) {
      throw new Error(
        `the checked-out branch ${JSON.stringify(branch)} is not a run branch, so there is no tag to ` +
          `infer — pass -tag <tag>`,
      )
    }
    resolved = branch.slice(BRANCH_PREFIX.length)
  }
  validTag(resolved)
  return {
    root,
    tag: resolved,
    branch: `${BRANCH_PREFIX}${resolved}`,
    stateDir: await stateDir(root, resolved),
  }
}

/** Loads the in-repo config, with a message naming what to run when absent. */
export async function loadRepoConfig(root) {
  try {
    return await loadConfig(join(root, CONFIG_PATH))
  } catch (err) {
    if (err.cause?.code === 'ENOENT') {
      throw new Error(`no ${CONFIG_PATH} in ${root}: run 'autor3search-javascript init' first`, { cause: err })
    }
    throw err
  }
}

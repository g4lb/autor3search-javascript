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

/**
 * Rewrites single-dash multi-character flags into the long form parseArgs
 * accepts.
 *
 * Node's parseArgs recognises a single dash ONLY for a single-character option
 * name, so `-C` works but `-tag` fails with "Unknown option '-t'" and `-desc`
 * with "Unknown option '-d'". This harness documents the single-dash spelling
 * throughout — program.md tells the agent to run `eval -desc "..."` and
 * `baseline -tag sep7`, matching the go tool it ports — so the tokens are
 * normalised here rather than changing a contract an agent already follows.
 *
 * Only an exact whole-token match is rewritten, so a VALUE that happens to
 * look like a flag (`-desc "-tag is confusing"`) is left alone.
 *
 * @param {string[]} args
 * @param {string[]} names long option names to accept in single-dash form
 * @returns {string[]}
 */
export function expandSingleDashFlags(args, names) {
  const single = new Set(names.map((name) => `-${name}`))
  let expectingValue = false
  return args.map((token) => {
    if (expectingValue) {
      expectingValue = false
      return token
    }
    if (single.has(token)) {
      expectingValue = true
      return `--${token.slice(1)}`
    }
    return token
  })
}

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

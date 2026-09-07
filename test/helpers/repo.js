import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Runs git in dir, returning trimmed stdout. */
export async function git(dir, ...args) {
  const { stdout } = await exec('git', args, { cwd: dir })
  return stdout.trim()
}

/**
 * Creates a temporary git repository with an initial commit.
 * `files` maps repo-relative paths to contents.
 *
 * The identity and default branch are set locally so the suite does not
 * depend on — or disturb — the developer's global git configuration.
 */
export async function makeRepo(files = { 'README.md': '# demo\n' }) {
  const dir = await mkdtemp(join(tmpdir(), 'a3s-repo-'))
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.email', 'test@example.com')
  await git(dir, 'config', 'user.name', 'Test')
  await writeFiles(dir, files)
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'initial')
  return dir
}

/** Writes a map of repo-relative paths to contents, creating directories. */
export async function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

/** Writes files and commits them. */
export async function commitFiles(dir, files, message = 'change') {
  await writeFiles(dir, files)
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', '--short=7', 'HEAD')
}

/** Helpers shared by the gates and by src/doctor.js. */
import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * Resolves a package entry point from inside the MEASURED repository, so the
 * repository's own installed tool versions are used — never this harness's.
 * A repository pinned to an older TypeScript must be typechecked by that
 * TypeScript, or the gate would report errors its own build never sees.
 *
 * @returns {string|null} an absolute path, or null when it does not resolve
 */
export function resolveFrom(dir, specifier) {
  try {
    return createRequire(join(dir, 'noop.js')).resolve(specifier)
  } catch {
    return null
  }
}

/** Every source file under dir with one of the given extensions, repo-relative. */
export async function walkSources(dir, exts) {
  const skipDirs = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.git'])
  const out = []
  async function visit(absolute) {
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const child = join(absolute, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue
        await visit(child)
      } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
        out.push(relative(dir, child).split(sep).join('/'))
      }
    }
  }
  await visit(dir)
  return out.sort()
}

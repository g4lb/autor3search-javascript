/** Helpers shared by the gates and by src/doctor.js. */
import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

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
    // resolve() FIRST. createRequire throws on a relative path, which the
    // catch below turns into null — indistinguishable from "the tool is not
    // installed". That silent false negative already bit once: `doctor -C .`
    // reported vitest missing in repositories that had it. Guarding here
    // rather than at each call site means no future caller can hit it.
    return createRequire(join(resolve(dir), 'noop.js')).resolve(specifier)
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

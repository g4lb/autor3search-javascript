/**
 * Decides which files an agent is allowed to modify.
 *
 * Patterns are globs ("src/**", "lib/**\/*.js"). The Go harness used the go
 * tool's "./..." directory-prefix form; that form is accepted here as an
 * alias so a configuration can be carried across, but globs are the
 * documented shape because they are what a JavaScript project expects.
 */
import picomatch from 'picomatch'

/**
 * Compiles scope patterns into a matcher over repository-relative paths.
 *
 * A blank or whitespace-only pattern is SKIPPED rather than treated as the
 * repository root, so a stray empty entry in a config list matches nothing
 * instead of silently granting root-level access.
 *
 * @param {string[]} patterns
 * @returns {{ match(rel: string): boolean }}
 */
export function createMatcher(patterns) {
  if (patterns != null && !Array.isArray(patterns)) {
    // A bare string would be iterated CHARACTER BY CHARACTER by the loop
    // below, silently degrading "**" into two one-character patterns. A
    // security gate must fail closed and loudly, not quietly narrow itself.
    throw new TypeError(`scope patterns must be an array, got ${typeof patterns}`)
  }

  const compiled = []
  for (const raw of patterns ?? []) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    // dot is deliberately LEFT OFF. With `dot: true`, the default "**" would
    // also match dot-files and dot-directories, so an agent scoped to the
    // whole repository could write .npmrc (redirecting the package registry)
    // or .github/workflows/*.yml (arbitrary CI execution) and have the change
    // accepted. The go tool this ports from ignores dot-directories for the
    // same reason. A user who genuinely wants one in scope names it
    // explicitly — picomatch still matches a literal dot written in the
    // pattern, so `scope: [".github/**"]` works while `**` does not reach it.
    compiled.push(picomatch(normalisePattern(trimmed)))
  }

  return {
    match(rel) {
      const path = normalisePath(rel)
      if (path === null) return false
      return compiled.some((isMatch) => isMatch(path))
    },
  }
}

/**
 * Rewrites a pattern into the glob picomatch will see: strips a leading
 * "./", and translates the go-tool "..." suffix into "**".
 */
function normalisePattern(p) {
  let out = p.replace(/\\/g, '/').replace(/^\.\//, '')
  if (out === '...') return '**'
  if (out.endsWith('/...')) return `${out.slice(0, -'/...'.length)}/**`
  return out
}

/**
 * Normalises a candidate path, returning null for anything that can never be
 * in scope no matter what the patterns say.
 *
 * The null cases have to be rejected EXPLICITLY, because they would otherwise
 * be admitted: "**" matches every string handed to it, so the one pattern
 * meaning "the whole repository" would also be the one meaning "anywhere on
 * the disk". Nothing produces such a path today — callers pass the output of
 * `git diff --name-only` and `git ls-files`, which are always root-relative —
 * so this is the gate refusing to depend on that staying true.
 */
function normalisePath(rel) {
  if (typeof rel !== 'string' || rel === '') return null
  const slashed = rel.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return null

  const parts = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // A ".." that cannot be cancelled by a preceding segment climbs out of
      // the repository root.
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

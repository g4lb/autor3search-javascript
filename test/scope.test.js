import { describe, expect, it } from 'vitest'
import { createMatcher } from '../src/scope.js'

describe('createMatcher', () => {
  it('matches everything under the default pattern', () => {
    const m = createMatcher(['**'])
    expect(m.match('index.js')).toBe(true)
    expect(m.match('src/deep/nested/file.js')).toBe(true)
  })

  it('matches only inside a named directory', () => {
    const m = createMatcher(['src/**'])
    expect(m.match('src/index.js')).toBe(true)
    expect(m.match('src/a/b/c.js')).toBe(true)
    expect(m.match('lib/index.js')).toBe(false)
    expect(m.match('index.js')).toBe(false)
  })

  it('honours an extension-restricted pattern', () => {
    const m = createMatcher(['lib/**/*.js'])
    expect(m.match('lib/a/b.js')).toBe(true)
    expect(m.match('lib/a/b.ts')).toBe(false)
  })

  it('accepts any of several patterns', () => {
    const m = createMatcher(['src/**', 'bin/**'])
    expect(m.match('src/x.js')).toBe(true)
    expect(m.match('bin/y.js')).toBe(true)
    expect(m.match('docs/z.md')).toBe(false)
  })

  it('normalises a leading ./ in both pattern and path', () => {
    const m = createMatcher(['./src/**'])
    expect(m.match('./src/x.js')).toBe(true)
    expect(m.match('src/x.js')).toBe(true)
  })

  it('accepts ./... as an alias for ** so a Go config still works', () => {
    const m = createMatcher(['./...'])
    expect(m.match('anything/at/all.js')).toBe(true)
  })

  it('accepts ./dir/... as an alias for dir/**', () => {
    const m = createMatcher(['./src/...'])
    expect(m.match('src/a/b.js')).toBe(true)
    expect(m.match('lib/a.js')).toBe(false)
  })

  it('skips a blank pattern instead of granting root access', () => {
    const m = createMatcher(['   '])
    expect(m.match('index.js')).toBe(false)
  })

  it('never matches an absolute path, even under the everything pattern', () => {
    const m = createMatcher(['**'])
    expect(m.match('/etc/passwd')).toBe(false)
  })

  it('never matches a path escaping the repository root', () => {
    const m = createMatcher(['**'])
    expect(m.match('../outside.js')).toBe(false)
    expect(m.match('..')).toBe(false)
    expect(m.match('src/../../outside.js')).toBe(false)
  })

  it('normalises backslash separators before matching', () => {
    const m = createMatcher(['src/**'])
    expect(m.match('src\\a\\b.js')).toBe(true)
  })

  it('never matches a Windows-style or UNC absolute path', () => {
    const m = createMatcher(['**'])
    expect(m.match('C:/Windows/system32')).toBe(false)
    expect(m.match('C:\\Windows\\system32')).toBe(false)
    expect(m.match('\\\\server\\share\\x.js')).toBe(false)
    expect(m.match('//etc/passwd')).toBe(false)
  })

  it('never matches a backslash-spelled escape', () => {
    const m = createMatcher(['**'])
    expect(m.match('a\\..\\..\\outside.js')).toBe(false)
    expect(m.match('src\\..\\..\\outside.js')).toBe(false)
  })

  it('still matches a path whose .. stays inside the root', () => {
    // False rejects are safe but annoying; this one must not be rejected.
    expect(createMatcher(['src/**']).match('src/a/../b.js')).toBe(true)
  })

  it('does not let a wildcard reach dot-files or dot-directories', () => {
    // Otherwise an agent scoped to the whole repository could write .npmrc or
    // .github/workflows/*.yml and have the edit accepted.
    const m = createMatcher(['**'])
    expect(m.match('.npmrc')).toBe(false)
    expect(m.match('.github/workflows/ci.yml')).toBe(false)
    expect(m.match('src/.env')).toBe(false)
  })

  it('matches a dot path when the pattern names it explicitly', () => {
    expect(createMatcher(['.github/**']).match('.github/workflows/ci.yml')).toBe(true)
  })

  it('matches nothing for an empty or absent pattern list', () => {
    expect(createMatcher([]).match('src/a.js')).toBe(false)
    expect(createMatcher(null).match('src/a.js')).toBe(false)
    expect(createMatcher(undefined).match('src/a.js')).toBe(false)
  })

  it('throws on a non-array pattern list rather than degrading silently', () => {
    // A bare string would be iterated character by character, turning "**"
    // into two one-character patterns without a word of complaint.
    expect(() => createMatcher('src/**')).toThrow(/must be an array/)
  })
})

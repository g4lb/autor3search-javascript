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
})

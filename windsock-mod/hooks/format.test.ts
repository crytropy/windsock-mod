import { expect, test } from 'claude-code/testing'

import {
  addPoint,
  branchNames,
  cellWidth,
  current,
  forecastFor,
  hasLimits,
  hasNoPr,
  HISTORY,
  isDetached,
  isHot,
  isPush,
  isQueued,
  mayQueue,
  mergeReading,
  mmss,
  modelWeekly,
  percentText,
  prPage,
  prRefOf,
  prStatus,
  prText,
  queueArgv,
  shortTokens,
  trendText,
  untilText,
} from './format'

test('red only above 80%', async () => {
  expect(isHot(80)).toBe(false)
  expect(isHot(80.5)).toBe(true)
  expect(isHot(undefined)).toBe(false)
})

test('percent and reset text', async () => {
  expect(percentText(42.4)).toBe('42%')
  expect(percentText(undefined)).toBe('--')
  const now = Date.parse('2026-10-16T10:00:00Z')
  expect(untilText('2026-10-16T13:05:30Z', now)).toBe('3h05m')
  expect(untilText('2026-10-16T10:20:00Z', now)).toBe('20m')
  expect(untilText('2026-10-16T09:00:00Z', now)).toBe('<1m')
})

test('reading from usage', async () => {
  const r = mergeReading(null, {
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-16T11:30:00Z' },
      { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-10-20T00:00:00Z' },
    ],
  })
  expect(r.context).toBe(25)
  expect(r.fiveHour).toBe(85)
  expect(r.fiveHourResetsAt).toBe('2026-10-16T11:30:00Z')
  expect(r.weekly).toBe(12)
  expect(hasLimits(r)).toBe(true)
  expect(hasLimits({ context: 25 })).toBe(false)
})

test('usage without rate limits keeps the old figures, context does not carry over', async () => {
  const prev = { context: 60, fiveHour: 40, fiveHourResetsAt: '2026-10-16T11:30:00Z', weekly: 12 }
  const r = mergeReading(prev, { context: { window: 200000 }, rateLimits: [] })
  expect(r.context).toBeUndefined()
  expect(r.fiveHour).toBe(40)
  expect(r.fiveHourResetsAt).toBe('2026-10-16T11:30:00Z')
  expect(r.weekly).toBe(12)
})

test('a kept figure is dropped once its window has reset', async () => {
  const r = { fiveHour: 40, fiveHourResetsAt: '2026-10-16T11:30:00Z', weekly: 12, weeklyResetsAt: '2026-10-20T00:00:00Z' }
  expect(current(r, Date.parse('2026-10-16T11:00:00Z')).fiveHour).toBe(40)
  const after = current(r, Date.parse('2026-10-16T11:30:00Z'))
  expect(after.fiveHour).toBeUndefined()
  expect(after.weekly).toBe(12)
})

test('countdown text rounds up to the second', async () => {
  expect(mmss(60 * 60 * 1000)).toBe('60:00')
  expect(mmss(5 * 60 * 1000 - 1)).toBe('05:00')
  expect(mmss(61_001)).toBe('01:02')
  // Run out, it stays at zero.
  expect(mmss(0)).toBe('00:00')
  expect(mmss(-90_000)).toBe('00:00')
})

test('CJK characters take two cells', async () => {
  expect(cellWidth('Week 12%')).toBe(8)
  expect(cellWidth('快取剩 52:13')).toBe(12)
  expect(cellWidth('，')).toBe(2)
})

test('Token Weather: forecast bands, trend, short tokens', async () => {
  expect(forecastFor(0).word).toBe('Clear')
  expect(forecastFor(25).word).toBe('Cloudy')
  expect(forecastFor(74).word).toBe('Showers')
  expect(forecastFor(89).word).toBe('Storm')
  expect(forecastFor(90).word).toBe('Compact soon')

  const h = [20000, 80000, 160000].reduce((acc, tokens) => addPoint(acc, { tokens, window: 200000 }), [] as { tokens: number; window: number }[])
  expect(trendText(h)).toBe('▲ +80k')
  expect(trendText(h.slice(0, 1))).toBe('')
  expect(trendText([h[2], h[1]])).toBe('▼ 80k')
  expect(trendText([h[1], h[1]])).toBe('steady')

  let long: { tokens: number; window: number }[] = []
  for (let i = 1; i <= 15; i++) long = addPoint(long, { tokens: i, window: 100 })
  expect(long.length).toBe(HISTORY)
  expect(long[0].tokens).toBe(4)

  expect(shortTokens(134400)).toBe('134.4k')
  expect(shortTokens(200000)).toBe('200k')
  expect(shortTokens(1000000)).toBe('1M')
  expect(shortTokens(512)).toBe('512')
})

test('Fable weekly window from the usage endpoint', async () => {
  const body = JSON.stringify({
    seven_day: { utilization: 47, resets_at: '2026-11-16T00:00:00Z' },
    limits: [
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Opus' } }, percent: 10, resets_at: 1763251200 },
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 23.5, resets_at: 1763251200 },
    ],
  })
  expect(modelWeekly(body, 'Fable')).toEqual({ percent: 23.5, resetsAt: '2025-11-16T00:00:00.000Z' })
  expect(modelWeekly(JSON.stringify({ limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'fable' } }, percent: 5, resets_at: '2026-11-16T00:00:00Z' }] }), 'Fable')).toEqual({ percent: 5, resetsAt: '2026-11-16T00:00:00Z' })
  expect(modelWeekly(JSON.stringify({ seven_day: {} }), 'Fable')).toEqual({})
  expect(modelWeekly(JSON.stringify({ limits: [] }), 'Fable')).toEqual({})
  expect(modelWeekly('not json', 'Fable')).toBeNull()
})

test('pull request from gh: checks running, ready to merge, merged, nothing otherwise', async () => {
  const url = 'https://github.com/acme/app/pull/12'
  const view = { number: 12, url, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
  const run = (status: string, conclusion: string) => ({ __typename: 'CheckRun', status, conclusion })
  const status = (state: string) => ({ __typename: 'StatusContext', state })
  const of = (pr: object) => prStatus(JSON.stringify(pr))

  expect(of({ ...view, statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('QUEUED', '')] })).toEqual({ kind: 'running', number: 12, url })
  expect(of({ ...view, statusCheckRollup: [status('PENDING')] })).toEqual({ kind: 'running', number: 12, url })
  expect(of({ ...view, statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), status('SUCCESS')] })).toEqual({ kind: 'ready', number: 12, url })
  // No checks at all: none is failing.
  expect(of({ ...view, statusCheckRollup: [] })).toEqual({ kind: 'ready', number: 12, url })
  expect(of({ ...view, state: 'MERGED', mergeable: 'UNKNOWN', statusCheckRollup: [run('COMPLETED', 'FAILURE')] })).toEqual({ kind: 'merged', number: 12, url })

  expect(of({ ...view, statusCheckRollup: [run('COMPLETED', 'FAILURE')] })).toBeNull()
  expect(of({ ...view, statusCheckRollup: [status('ERROR')] })).toBeNull()
  expect(of({ ...view, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [] })).toBeNull()
  expect(of({ ...view, mergeStateStatus: 'BLOCKED', statusCheckRollup: [] })).toBeNull()
  expect(of({ ...view, isDraft: true, statusCheckRollup: [run('IN_PROGRESS', '')] })).toBeNull()
  expect(of({ ...view, state: 'CLOSED', statusCheckRollup: [] })).toBeNull()
  // Not a pull request, or a link that is not a web page.
  expect(prStatus('no pull requests found')).toBeNull()
  expect(of({ ...view, url: 'javascript:alert(1)' })).toBeNull()
  expect(of({ state: 'OPEN' })).toBeNull()

  expect(prText({ kind: 'running', number: 12, url })).toBe('◐ PR #12')
  expect(prText({ kind: 'ready', number: 12, url })).toBe('✓ PR #12')
  expect(prText({ kind: 'merged', number: 7, url })).toBe('● PR #7')
})

test('just pushed: GitHub has not worked the pull request out yet, so it shows as running', async () => {
  const url = 'https://github.com/acme/app/pull/12'
  const view = { number: 12, url, state: 'OPEN', isDraft: false }
  const run = (status: string, conclusion: string) => ({ __typename: 'CheckRun', status, conclusion })
  const of = (pr: object) => prStatus(JSON.stringify(pr))

  // No checks in yet, mergeability not worked out.
  expect(of({ ...view, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [] })).toEqual({ kind: 'running', number: 12, url })
  // Mergeable but no checks yet: just pushed, its checks are not in yet; later, it has none.
  const clean = JSON.stringify({ ...view, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] })
  expect(prStatus(clean, true)).toEqual({ kind: 'running', number: 12, url })
  expect(prStatus(clean)).toEqual({ kind: 'ready', number: 12, url })
  const passed = JSON.stringify({ ...view, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  expect(prStatus(passed, true)).toEqual({ kind: 'ready', number: 12, url })
  expect(of({ ...view, mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [run('COMPLETED', 'SUCCESS')] })).toEqual({ kind: 'running', number: 12, url })
  // A failed check still draws nothing, worked out or not.
  expect(of({ ...view, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [run('COMPLETED', 'FAILURE')] })).toBeNull()
  // Still a draft: nothing.
  expect(of({ ...view, isDraft: true, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [] })).toBeNull()
})

test('a push or a new pull request is told from other commands', async () => {
  expect(isPush('git push')).toBe(true)
  expect(isPush('git push -u origin feat/x')).toBe(true)
  expect(isPush('cd app && git -C . push --force-with-lease')).toBe(true)
  expect(isPush('gh pr create --fill')).toBe(true)
  expect(isPush('gh pr ready 12')).toBe(true)
  expect(isPush('git status')).toBe(false)
  expect(isPush('git log | grep push')).toBe(false)
  expect(isPush('gh pr view')).toBe(false)
})

test('the pull request a command touched: its page, else the branch a push went to', async () => {
  const page = 'https://github.com/acme/app/pull/12'
  expect(prRefOf({ gitOperation: { pr: { number: 12, url: page, action: 'created' } } })).toBe(page)
  expect(prRefOf({ gitOperation: { push: { branch: 'feat/x' }, pr: { number: 12, url: page, action: 'ready' } } })).toBe(page)
  // No page from the engine: the one `gh` printed for that number.
  expect(prRefOf({ stdout: `Creating pull request\n${page}\n`, gitOperation: { pr: { number: 12, action: 'created' } } })).toBe(page)
  expect(prRefOf({ stdout: 'https://github.com/acme/app/pull/120\n', gitOperation: { pr: { number: 12, action: 'created' } } })).toBe(null)
  expect(prRefOf({ gitOperation: { push: { branch: 'feat/x' } } })).toBe('feat/x')
  // Someone else's pull request, or one that is no longer open: not this session's to keep.
  expect(prRefOf({ gitOperation: { pr: { number: 12, url: page, action: 'commented' } } })).toBe(null)
  expect(prRefOf({ gitOperation: { pr: { number: 12, url: page, action: 'merged' } } })).toBe(null)
  expect(prRefOf({ gitOperation: { commit: { sha: 'abc', kind: 'committed' } } })).toBe(null)
  expect(prRefOf({ stdout: page })).toBe(null)
  expect(prRefOf(undefined)).toBe(null)
})

test('gh failing for want of a pull request, not for a moment', async () => {
  expect(hasNoPr('no pull requests found for branch "main"')).toBe(true)
  expect(hasNoPr('fatal: not a git repository (or any of the parent directories): .git')).toBe(true)
  expect(hasNoPr('none of the git remotes configured for this repository point to a known GitHub host')).toBe(true)
  expect(hasNoPr('To get started with GitHub CLI, please run:  gh auth login')).toBe(true)
  expect(hasNoPr('error connecting to api.github.com')).toBe(false)
  expect(hasNoPr('HTTP 502: Bad Gateway')).toBe(false)
})

test('merge queue: only an open pull request with its checks passed is asked, and the answer read', async () => {
  const url = 'https://github.com/acme/app/pull/12'
  const view = { number: 12, url, state: 'OPEN', isDraft: false }
  const run = (status: string, conclusion: string) => ({ __typename: 'CheckRun', status, conclusion })
  expect(mayQueue(JSON.stringify({ ...view, statusCheckRollup: [run('COMPLETED', 'SUCCESS')] }))).toBe(true)
  expect(mayQueue(JSON.stringify({ ...view, statusCheckRollup: [] }))).toBe(true)
  expect(mayQueue(JSON.stringify({ ...view, statusCheckRollup: [run('IN_PROGRESS', '')] }))).toBe(false)
  expect(mayQueue(JSON.stringify({ ...view, statusCheckRollup: [run('COMPLETED', 'FAILURE')] }))).toBe(false)
  expect(mayQueue(JSON.stringify({ ...view, isDraft: true, statusCheckRollup: [] }))).toBe(false)
  expect(mayQueue(JSON.stringify({ ...view, state: 'MERGED', statusCheckRollup: [] }))).toBe(false)
  expect(mayQueue('no pull requests found')).toBe(false)

  expect(queueArgv(url).slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(queueArgv(url)).toContain(`url=${url}`)

  expect(isQueued(JSON.stringify({ data: { resource: { isInMergeQueue: true } } }))).toBe(true)
  expect(isQueued(JSON.stringify({ data: { resource: { isInMergeQueue: false } } }))).toBe(false)
  expect(isQueued(JSON.stringify({ data: { resource: null } }))).toBe(false)
  expect(isQueued('null')).toBe(false)
  expect(isQueued('HTTP 502')).toBe(false)
  expect(prText({ kind: 'queued', number: 12, url })).toBe('⧗ PR #12')
})

test('a pull request page and whether it is still open', async () => {
  const url = 'https://github.com/acme/app/pull/12'
  expect(prPage(JSON.stringify({ number: 12, url, state: 'OPEN', isDraft: true }))).toEqual({ url, isOpen: true })
  expect(prPage(JSON.stringify({ number: 12, url, state: 'MERGED' }))).toEqual({ url, isOpen: false })
  expect(prPage(JSON.stringify({ number: 12, url, state: 'CLOSED' }))).toEqual({ url, isOpen: false })
  expect(prPage(JSON.stringify({ url: 'javascript:alert(1)', state: 'OPEN' }))).toBeNull()
  expect(prPage('no pull requests found')).toBeNull()
})

test('gh failing because no branch is checked out', async () => {
  expect(isDetached('could not determine current branch: failed to run git: not on any branch')).toBe(true)
  expect(isDetached('no pull requests found for branch "main"')).toBe(false)
  expect(isDetached('HTTP 502: Bad Gateway')).toBe(false)
})

test('the branches at a commit, one a line, a few at most', async () => {
  expect(branchNames('main\nfeat/keys\n')).toEqual(['main', 'feat/keys'])
  expect(branchNames('  feat/keys \r\n\r\n')).toEqual(['feat/keys'])
  expect(branchNames('')).toEqual([])
  expect(branchNames('a\nb\nc\nd\ne\nf\ng\n')).toEqual(['a', 'b', 'c', 'd', 'e'])
})

import type { SessionUsage } from 'claude-code'

import type { Limits, Point, Pr, Reading } from '../types'

export const RED_AT = 80
export const HISTORY = 12

// Token Weather's forecast bands, by percent of the window used.
// Single-width text symbols, not emoji: they line up in every terminal font.
export const FORECAST = [
  { upTo: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { upTo: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { upTo: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: 'error' },
] as const

export function forecastFor(percent: number): (typeof FORECAST)[number] {
  return FORECAST.find(f => percent < f.upTo) ?? FORECAST[FORECAST.length - 1]
}

/** The history with a new reading last, at most HISTORY long. */
export function addPoint(history: Point[], point: Point): Point[] {
  return [...history, point].slice(-HISTORY)
}

/** What the last turn added, as "▲ +98.3k", "▼ 12k" or "steady"; empty with fewer than two readings. */
export function trendText(history: Point[]): string {
  if (history.length < 2) return ''
  const delta = history[history.length - 1].tokens - history[history.length - 2].tokens
  if (delta > 0) return `▲ +${shortTokens(delta)}`
  if (delta < 0) return `▼ ${shortTokens(-delta)}`
  return 'steady'
}

/** Tokens as "134.4k", "200k" or "1M". */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

export function isHot(percent: number | undefined): boolean {
  return percent !== undefined && percent > RED_AT
}

export function percentText(percent: number | undefined): string {
  return percent === undefined ? '--' : `${Math.round(percent)}%`
}

/** Time until `resetsAt`, as "3h12m", "45m" or "<1m". */
export function untilText(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined
  const ms = Date.parse(resetsAt) - now
  if (Number.isNaN(ms)) return undefined
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 1) return '<1m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

/**
 * The new figures over the old: a rate-limit window the usage leaves out (a new
 * session before its first response) keeps its old figure.
 */
export function mergeReading(prev: Reading | null, usage: Pick<SessionUsage, 'context' | 'rateLimits'>): Reading {
  const five = usage.rateLimits.find(r => r.kind === 'five_hour')
  const week = usage.rateLimits.find(r => r.kind === 'seven_day')
  return {
    context: usage.context.percent,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    fiveHour: five ? five.percentUsed : prev?.fiveHour,
    fiveHourResetsAt: five ? five.resetsAt : prev?.fiveHourResetsAt,
    weekly: week ? week.percentUsed : prev?.weekly,
    weeklyResetsAt: week ? week.resetsAt : prev?.weeklyResetsAt,
    // The session's usage has no per-model window: Fable comes from the usage endpoint alone.
    fable: prev?.fable,
    fableResetsAt: prev?.fableResetsAt,
  }
}

export function hasLimits(r: Reading | null | undefined): boolean {
  return r?.fiveHour !== undefined || r?.weekly !== undefined || r?.fable !== undefined
}

export function limitsOf(r: Reading): Limits {
  const { fiveHour, fiveHourResetsAt, weekly, weeklyResetsAt, fable, fableResetsAt } = r
  return { fiveHour, fiveHourResetsAt, weekly, weeklyResetsAt, fable, fableResetsAt }
}

/**
 * A model's weekly window from the account's usage (`/api/oauth/usage`): its
 * `weekly_scoped` entry in `limits` whose model is named `model`. `{}` when the
 * account has no such window, null when the body is not usage.
 */
export function modelWeekly(body: string, model: string): { percent?: number; resetsAt?: string } | null {
  let usage: unknown
  try {
    usage = JSON.parse(body)
  } catch {
    return null
  }
  if (usage === null || typeof usage !== 'object') return null
  const limits = (usage as { limits?: unknown }).limits
  if (!Array.isArray(limits)) return {}
  const entry = limits.find(
    (l: any) =>
      l !== null &&
      typeof l === 'object' &&
      l.kind === 'weekly_scoped' &&
      typeof l.scope?.model?.display_name === 'string' &&
      l.scope.model.display_name.toLowerCase() === model.toLowerCase(),
  ) as { percent?: unknown; resets_at?: unknown } | undefined
  if (entry === undefined || typeof entry.percent !== 'number') return {}
  const at = entry.resets_at
  const resetsAt =
    typeof at === 'number' ? new Date(at * 1000).toISOString() : typeof at === 'string' ? at : undefined
  return { percent: entry.percent, ...(resetsAt !== undefined ? { resetsAt } : {}) }
}

/** A kept figure whose window has since reset no longer holds: drop it. */
export function current(r: Reading, now: number): Reading {
  const isPast = (at: string | undefined) => at !== undefined && Date.parse(at) <= now
  return {
    ...r,
    ...(isPast(r.fiveHourResetsAt) ? { fiveHour: undefined, fiveHourResetsAt: undefined } : {}),
    ...(isPast(r.weeklyResetsAt) ? { weekly: undefined, weeklyResetsAt: undefined } : {}),
    ...(isPast(r.fableResetsAt) ? { fable: undefined, fableResetsAt: undefined } : {}),
  }
}

/** Milliseconds as "52:13" or "04:59", rounded up to the second; a time that has run out stays "00:00". */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// The four pull-request states the band draws; any other draws nothing.
export const PR_MARK = {
  running: { icon: '◐', color: 'warning' },
  ready: { icon: '✓', color: 'success' },
  queued: { icon: '⧗', color: 'suggestion' },
  merged: { icon: '●', color: 'merged' },
} as const

/** A pull request as the band names it: "✓ PR #12". */
export function prText(pr: Pr): string {
  return `${PR_MARK[pr.kind].icon} PR #${pr.number}`
}

// A check that is not one of these has failed.
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
// GitHub will not merge a pull request in one of these states.
const BLOCKED = ['BLOCKED', 'DIRTY', 'DRAFT', 'BEHIND']

/**
 * The current branch's pull request from `gh pr view --json
 * number,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup`:
 * merged, its checks still running, or its checks passed and mergeable (a pull
 * request with no checks has none failing). Just pushed, while GitHub has not
 * yet worked out whether it merges (`UNKNOWN`), it counts as running too; so
 * does one `isJustPushed` with no checks yet, as GitHub takes a few seconds to
 * hang a new pull request's checks on it.
 * Null for any other state (a draft, a failed check, a conflict, closed) and
 * for a body that is no pull request.
 */
export function prStatus(body: string, isJustPushed = false): Pr | null {
  let pr: any
  try {
    pr = JSON.parse(body)
  } catch {
    return null
  }
  if (pr === null || typeof pr !== 'object') return null
  const { number, url } = pr
  if (!Number.isInteger(number) || typeof url !== 'string' || !url.startsWith('https://')) return null
  if (pr.state === 'MERGED') return { kind: 'merged', number, url }
  if (pr.state !== 'OPEN' || pr.isDraft === true) return null

  // A check run has a status and a conclusion; a commit status has a state alone.
  const checks: any[] = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.filter((c: unknown) => c !== null && typeof c === 'object') : []
  const isRunning = (c: any) => (typeof c.status === 'string' ? c.status !== 'COMPLETED' : c.state === 'PENDING' || c.state === 'EXPECTED')
  const hasPassed = (c: any) => PASSED.includes(typeof c.status === 'string' ? c.conclusion : c.state)
  if (checks.some(isRunning)) return { kind: 'running', number, url }
  // Just pushed or opened: no checks yet may be checks not in yet, not a pull request without any.
  if (checks.length === 0 && isJustPushed) return { kind: 'running', number, url }
  if (!checks.every(hasPassed)) return null
  // Just pushed: GitHub is still working out the new head, and its checks may not be in yet.
  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') return { kind: 'running', number, url }
  if (pr.mergeable !== 'MERGEABLE' || BLOCKED.includes(pr.mergeStateStatus)) return null
  return { kind: 'ready', number, url }
}

// `gh pr view` has no merge-queue field: GitHub's GraphQL API, asked by the pull request's page.
const QUEUE_QUERY = 'query($url:URI!){resource(url:$url){... on PullRequest{isInMergeQueue}}}'

/** The `gh` command that asks whether the pull request at `url` is in its merge queue. */
export function queueArgv(url: string): string[] {
  return ['gh', 'api', 'graphql', '-f', `query=${QUEUE_QUERY}`, '-f', `url=${url}`]
}

/**
 * Whether a pull request from `gh pr view --json ...` may be in a merge queue:
 * open, no draft, and its checks all done and passed. Only these are asked.
 */
export function mayQueue(body: string): boolean {
  let pr: any
  try {
    pr = JSON.parse(body)
  } catch {
    return false
  }
  if (pr === null || typeof pr !== 'object' || pr.state !== 'OPEN' || pr.isDraft === true) return false
  const checks: any[] = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.filter((c: unknown) => c !== null && typeof c === 'object') : []
  return checks.every(c => PASSED.includes(typeof c.status === 'string' ? c.conclusion : c.state))
}

/** Whether the answer to `queueArgv` says the pull request is in its merge queue. */
export function isQueued(body: string): boolean {
  try {
    return JSON.parse(body)?.data?.resource?.isInMergeQueue === true
  } catch {
    return false
  }
}

/**
 * The pull request's page and whether it is still open (a draft is), from `gh
 * pr view --json ...`: null for a body that is no pull request.
 */
export function prPage(body: string): { url: string; isOpen: boolean } | null {
  let pr: any
  try {
    pr = JSON.parse(body)
  } catch {
    return null
  }
  if (pr === null || typeof pr !== 'object') return null
  if (typeof pr.url !== 'string' || !pr.url.startsWith('https://')) return null
  return { url: pr.url, isOpen: pr.state === 'OPEN' }
}

/**
 * Whether `gh pr view` failed because there is no pull request to show (none
 * for the branch, no repository, no GitHub remote, not signed in), rather than
 * for a moment (the network, GitHub itself).
 */
export function hasNoPr(stderr: string): boolean {
  return /no pull requests found|not a git repository|no git remotes|known GitHub host|gh auth login/i.test(stderr)
}

/**
 * Whether `gh pr view` failed because no branch is checked out (a detached
 * HEAD): a branch at the same commit may still have a pull request.
 */
export function isDetached(stderr: string): boolean {
  return /not on any branch/i.test(stderr)
}

// Branches at one commit asked for a pull request, at most.
const BRANCHES_MAX = 5

/** The branch names `git for-each-ref --format=%(refname:short)` printed, one a line: the first few. */
export function branchNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(0, BRANCHES_MAX)
}

/** Whether a shell command pushes a branch or opens its pull request. */
export function isPush(command: string): boolean {
  return /\bgit\b[^\n;|&]*\bpush\b|\bgh\s+pr\s+(create|ready|reopen)\b/.test(command)
}

// What a command does to a pull request that makes it this session's to keep on the band.
const OWN_PR_ACTIONS = ['created', 'edited', 'ready', 'draft', 'reopened', 'auto-merge-enabled']

/**
 * The pull request a Bash or PowerShell command touched, from the engine's
 * reading of it (`gitOperation`): its page, or else the branch a push went to.
 * The command may have run in another worktree or off any branch, so the
 * session folder's own branch does not find it.
 */
export function prRefOf(result: unknown): string | null {
  const r = result as { stdout?: unknown; gitOperation?: { pr?: any; push?: any } } | null | undefined
  const op = r?.gitOperation
  if (op === null || typeof op !== 'object') return null
  const pr = op.pr
  if (pr !== null && typeof pr === 'object' && OWN_PR_ACTIONS.includes(pr.action)) {
    if (typeof pr.url === 'string' && pr.url.startsWith('https://')) return pr.url
    // No page from the engine: the one `gh` printed for that number.
    const printed = typeof r?.stdout === 'string' ? r.stdout.match(/https:\/\/\S+\/pull\/(\d+)\b/g) : null
    const page = printed?.find(u => u.endsWith(`/pull/${pr.number}`))
    if (page !== undefined) return page
  }
  const branch = op.push?.branch
  return typeof branch === 'string' && branch !== '' ? branch : null
}

/** The names a transcript gives its session: the one a person or a tool set, and Claude Code's own. */
export type Titles = { custom?: string; ai?: string }

// Whole lines of the transcript, not a quote of one inside a message, where quotes are escaped.
const TITLE_LINE = /^\{"type":"(custom-title|ai-title)","(?:customTitle|aiTitle)":("(?:[^"\\\n]|\\.)*")/gm

/** The last of each name in whole lines of a transcript, over what was found before. */
export function titlesIn(lines: string, found: Titles = {}): Titles {
  const next = { ...found }
  for (const m of lines.matchAll(TITLE_LINE)) {
    let name: unknown
    try {
      name = JSON.parse(m[2])
    } catch {
      continue
    }
    if (typeof name !== 'string' || name.trim() === '') continue
    if (m[1] === 'custom-title') next.custom = name.trim()
    else next.ai = name.trim()
  }
  return next
}

/** The session's name as Claude Code shows it: the one set first, else its own. */
export function titleOf(t: Titles): string | null {
  return t.custom ?? t.ai ?? null
}

/** Terminal cells a text takes: CJK and full-width characters take two. */
export function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const isWide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    width += isWide ? 2 : 1
  }
  return width
}

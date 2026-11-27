import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionUsage } from 'claude-code'

import type { Point, Pr, Reading, Stamp } from '../types'
import {
  PR_MARK,
  addPoint,
  branchNames,
  cellWidth,
  current,
  forecastFor,
  hasLimits,
  hasNoPr,
  isDetached,
  isHot,
  isPush,
  isQueued,
  limitsOf,
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
  titleOf,
  titlesIn,
  trendText,
  untilText,
} from './format'
import type { Titles } from './format'

const TTL_MS = 60 * 60 * 1000
const WARN_MS = 5 * 60 * 1000
const STORE_KEY = 'lastSentBySession'
const LIMITS_KEY = 'lastLimits'
const KEEP_SESSIONS = 20
const SEP = '   ·   '
// Fable's weekly window is not in the session's usage: read from the account's usage endpoint.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FABLE = 'Fable'
const FETCH_EVERY_MS = 5 * 60 * 1000
const RED_MS = 60 * 1000
// The current branch's pull request, as `gh` reports it.
const PR_ARGV = ['gh', 'pr', 'view', '--json', 'number,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup']
// The local branches at the checked-out commit: asked when no branch is checked out.
const AT_HEAD_ARGV = ['git', 'for-each-ref', '--points-at', 'HEAD', '--format=%(refname:short)', 'refs/heads']
const PR_EVERY_MS = 60 * 1000
const PR_IDLE_MS = 5 * 60 * 1000
const PR_TIMEOUT_MS = 15 * 1000
// After a push the clock asks each minute for a while, till the checks are in.
const PR_PUSHED_MS = 5 * 60 * 1000
// Open pull requests of this session's branches kept on the band after the branch moves on.
const HELD_MAX = 5
// The session's name is read off its transcript: a look at its size this often, the new bytes when it grew.
const TITLE_EVERY_MS = 15 * 1000
const TITLE_CHUNK = 4 * 1024 * 1024

const reading = atom({ plugin: 'windsock-mod', key: 'reading' } as const, null as Reading | null)
const lastSentAt = atom({ plugin: 'windsock-mod', key: 'lastSentAt' } as const, null as Stamp)
const warnedFor = atom({ plugin: 'windsock-mod', key: 'warnedFor' } as const, null as Stamp)
const history = atom({ plugin: 'windsock-mod', key: 'history' } as const, [] as Point[])
const prs = atom({ plugin: 'windsock-mod', key: 'prs' } as const, [] as Pr[])
const held = atom({ plugin: 'windsock-mod', key: 'held' } as const, [] as string[])
const title = atom({ plugin: 'windsock-mod', key: 'title' } as const, null as string | null)

/** A piece of the usage row: its text and how it is painted. */
type Part = { text: string; color?: string; dim?: boolean; bold?: boolean }

// The rate-limit windows are the account's: the last ones seen, kept across sessions.
async function keptLimits($: EngineInterface): Promise<Reading | null> {
  const r = await read($, reading)
  if (hasLimits(r)) return r
  return ((await $.store.get(LIMITS_KEY)) ?? null) as Reading | null
}

async function apply($: EngineInterface, usage: Pick<SessionUsage, 'context' | 'rateLimits'>): Promise<void> {
  const merged = mergeReading(await keptLimits($), usage)
  await update($, reading, () => merged)
  if (usage.rateLimits.length > 0) await $.store.set(LIMITS_KEY, limitsOf(merged))
}

// A new turn adds a reading for the trend; a first reading (a resumed session) seeds it.
async function record($: EngineInterface, context: SessionUsage['context'], isNewTurn: boolean): Promise<void> {
  if (!context.tokens || !context.window) return
  const point = { tokens: context.tokens, window: context.window }
  await update($, history, h => (isNewTurn || h.length === 0 ? addPoint(h, point) : h))
}

// A compaction is no turn: no measurement follows it, and the engine has no fill for the new
// window till its next response. Estimate the window locally at once, so the band drops with the
// conversation; the next measurement puts the engine's own figure in its place.
async function compacted($: EngineInterface, tokensAfter: number | undefined): Promise<void> {
  let tokens = tokensAfter
  let window = (await read($, reading))?.contextWindow
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    window = context.window
    if (context.breakdown !== undefined) tokens = context.breakdown.totalTokens
  } catch {
    // no estimate: the conversation's own size, as the compaction recorded it
  }
  if (tokens === undefined || !window) return
  const point = { tokens, window }
  await update($, reading, r => ({
    ...(r ?? {}),
    context: (point.tokens / point.window) * 100,
    contextTokens: point.tokens,
    contextWindow: point.window,
  }))
  await update($, history, h => addPoint(h, point))
}

let fetchedAt: number | null = null

// At most once every FETCH_EVERY_MS; a failed read keeps the last figure.
async function fetchFable($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (fetchedAt !== null && now - fetchedAt < FETCH_EVERY_MS) return
  fetchedAt = now
  try {
    const auth = await $.session.authorize()
    if (auth === null) return
    const res = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    })
    if (!res.ok) return
    const w = modelWeekly(res.text, FABLE)
    if (w === null) return
    const prev = await keptLimits($)
    const next: Reading = {
      ...(await read($, reading)),
      ...(prev ? limitsOf(prev) : {}),
      fable: w.percent,
      fableResetsAt: w.resetsAt,
    }
    await update($, reading, () => next)
    await $.store.set(LIMITS_KEY, limitsOf(next))
  } catch {
    // keep the last figure
  }
}

let prFetchedAt: number | null = null
let pushedAt: number | null = null
// The page of the pull request the last push or `gh pr` went to, when it was not the current branch's.
let pushedUrl: string | null = null

type View = { body: string } | 'none' | 'failed'

// `gh pr view` for the current branch, or for one pull request by its page or its branch's name:
// what it printed, 'none' with no pull request to show, 'failed' when the network or GitHub
// failed for a moment.
async function viewPr($: EngineInterface, ref?: string): Promise<View> {
  const argv = ref === undefined ? PR_ARGV : [...PR_ARGV.slice(0, 3), ref, ...PR_ARGV.slice(3)]
  let stderr: string
  try {
    const out = await $.process.run(argv, { timeoutMs: PR_TIMEOUT_MS })
    if (out.exitCode === 0) return { body: out.stdout }
    stderr = out.stderr
  } catch {
    // `gh` is not installed or did not answer
    return 'failed'
  }
  if (ref === undefined && isDetached(stderr)) return viewAtHead($)
  // No pull request for the branch, no repository, not signed in: nothing to draw.
  return hasNoPr(stderr) ? 'none' : 'failed'
}

// No branch is checked out (a detached HEAD), so `gh` has none to ask for: the pull request
// of the first local branch at the checked-out commit that has one.
async function viewAtHead($: EngineInterface): Promise<View> {
  let names: string[]
  try {
    const out = await $.process.run(AT_HEAD_ARGV, { timeoutMs: PR_TIMEOUT_MS })
    if (out.exitCode !== 0) return 'none'
    names = branchNames(out.stdout)
  } catch {
    // `git` did not answer: nothing for the commit, the pull requests seen before are still asked
    return 'none'
  }
  for (const name of names) {
    const view = await viewPr($, name)
    if (view !== 'none') return view
  }
  return 'none'
}

// What the band draws for a pull request `gh pr view` printed: one whose checks passed is
// asked whether it waits in its merge queue; GitHub failing for that keeps what `gh pr view` said.
async function statusOf($: EngineInterface, body: string, isJustPushed: boolean): Promise<Pr | null> {
  const p = prStatus(body, isJustPushed)
  if (!mayQueue(body)) return p
  const { number, url } = JSON.parse(body)
  if (!Number.isInteger(number) || typeof url !== 'string' || !url.startsWith('https://')) return p
  try {
    const out = await $.process.run(queueArgv(url), { timeoutMs: PR_TIMEOUT_MS })
    if (out.exitCode === 0 && isQueued(out.stdout)) return { kind: 'queued', number, url }
  } catch {
    // `gh` did not answer
  }
  return p
}

// The current branch's pull request, then the other open ones this session's branches had,
// asked of `gh`: a push asks at once; a turn asks again after PR_EVERY_MS; the clock after
// PR_IDLE_MS, or after PR_EVERY_MS while checks run and for PR_PUSHED_MS after a push.
// `touched` is the page or branch a push or `gh pr` went to: it may be another worktree's,
// not the current branch's, so it is asked by itself and kept with the others.
async function fetchPr($: EngineInterface, isTurn: boolean, isPushed = false, touched: string | null = null): Promise<void> {
  const now = await $.clock.now()
  if (isPushed) pushedAt = now
  const last = await read($, prs)
  if (prFetchedAt !== null && !isPushed) {
    const isSoon = isTurn || last.some(p => p.kind === 'running' || p.kind === 'queued') || (pushedAt !== null && now - pushedAt < PR_PUSHED_MS)
    if (now - prFetchedAt < (isSoon ? PR_EVERY_MS : PR_IDLE_MS)) return
  }
  prFetchedAt = now

  const branch = await viewPr($)
  // The network or GitHub failed for a moment: keep the last ones.
  if (branch === 'failed') return
  const next: Pr[] = []
  let urls = await read($, held)
  // What `gh` printed this time, by page, so a pull request is asked once.
  const seen = new Map<string, View>()
  if (isPushed) pushedUrl = null
  if (touched !== null) {
    const view = await viewPr($, touched)
    const page = view === 'none' || view === 'failed' ? null : prPage(view.body)
    const url = page?.url ?? (touched.startsWith('https://') ? touched : null)
    if (url !== null && (page === null || page.isOpen)) {
      if (view !== 'none' && view !== 'failed') seen.set(url, view)
      pushedUrl = url
      urls = [url, ...urls.filter(u => u !== url)].slice(0, HELD_MAX)
    }
  }
  const isFresh = (url: string) => url === pushedUrl && pushedAt !== null && now - pushedAt < PR_PUSHED_MS
  let branchUrl: string | null = null
  if (branch !== 'none') {
    const page = prPage(branch.body)
    if (page !== null) {
      branchUrl = page.url
      urls = urls.filter(u => u !== page.url)
      if (page.isOpen) urls = [page.url, ...urls].slice(0, HELD_MAX)
    }
    // A push is the current branch's: its checks may not be in yet.
    const p = await statusOf($, branch.body, pushedAt !== null && now - pushedAt < PR_PUSHED_MS)
    if (p !== null) next.push(p)
  }

  // The branch moved on: its pull request stays on the band till it is merged or closed.
  const kept: string[] = []
  for (const url of urls) {
    if (url === branchUrl) {
      kept.push(url)
      continue
    }
    const view = seen.get(url) ?? (await viewPr($, url))
    if (view === 'failed') {
      kept.push(url)
      const before = last.find(p => p.url === url)
      if (before !== undefined) next.push(before)
      continue
    }
    if (view === 'none' || prPage(view.body)?.isOpen !== true) continue
    kept.push(url)
    const p = await statusOf($, view.body, isFresh(url))
    if (p !== null) next.push(p)
  }
  await update($, held, () => kept)
  await update($, prs, () => next)
}

let titleAt: number | null = null
let titlePath: string | null = null
let titleOffset = 0
let titlesFound: Titles = {}

// The session's name, as `/rename`, the desktop app or Claude Code's own naming wrote it into the
// transcript. The transcript only grows: each look reads the whole lines added since the last one.
async function fetchTitle($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (titleAt !== null && now - titleAt < TITLE_EVERY_MS) return
  titleAt = now
  try {
    const { transcriptPath } = await $.session.info()
    if (transcriptPath === '') return
    const { size } = await $.fs.stat(transcriptPath)
    // A /clear starts another transcript; a shorter one is read again from the start.
    if (transcriptPath !== titlePath || size < titleOffset) {
      titlePath = transcriptPath
      titleOffset = 0
      titlesFound = {}
    }
    while (titleOffset < size) {
      const length = Math.min(TITLE_CHUNK, size - titleOffset)
      const { base64 } = (await $.fs.read(transcriptPath, { as: 'bytes', offset: titleOffset, length })) as { base64: string }
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
      const end = bytes.lastIndexOf(0x0a)
      if (end < 0) {
        // A line still being written waits for its end; one longer than a read (an image) is no name.
        if (length < TITLE_CHUNK) break
        titleOffset += length
        continue
      }
      titlesFound = titlesIn(new TextDecoder().decode(bytes.subarray(0, end + 1)), titlesFound)
      titleOffset += end + 1
    }
    const name = titleOf(titlesFound)
    if (name !== (await read($, title))) await update($, title, () => name)
  } catch {
    // no transcript to read: keep the last name
  }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage()
    await apply($, usage)
    await record($, usage.context, false)
  } catch {
    // keep the last reading
  }
}

// Kept per session in $.store so a resumed session picks its countdown back up.
async function remember($: EngineInterface, at: number): Promise<void> {
  const id = await $.session.id()
  const saved = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, number>
  delete saved[id]
  const entries = [...Object.entries(saved), [id, at] as const].slice(-KEEP_SESSIONS)
  await $.store.set(STORE_KEY, Object.fromEntries(entries))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    await fetchFable($)
    await fetchPr($, true)
    await fetchTitle($)

    if ((await read($, lastSentAt)) === null) {
      const saved = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, number>
      const at = saved[await $.session.id()]
      if (at !== undefined) {
        await update($, lastSentAt, () => at)
      }
    }

    $.clock.every(1000, async () => {
      const sent = await read($, lastSentAt)
      if (sent !== null) {
        const left = sent + TTL_MS - (await $.clock.now())
        if (left > 0 && left <= WARN_MS && (await read($, warnedFor)) !== sent) {
          await update($, warnedFor, () => sent)
          const text = `主對話的快取剩 ${mmss(left)} 就過期，要續命就趁現在送一句`
          $.ui.toast(text)
          $.ui.notify(text, { title: 'Prompt cache' }).catch(() => undefined)
        }

        $.ui.invalidate('ui.render')
      }

      await fetchPr($, false)
      await fetchTitle($)
    })

    return result
  })

  // Each main-loop request reads and refreshes the cache; subagents' requests do not count.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, lastSentAt, () => at)
      await remember($, at)
    }

    return yield* next(e)
  })

  // A push, or a pull request just opened: ask `gh` at once, so the band shows its checks starting.
  // The engine's reading of the command names the branch or page, which may be another worktree's.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if ((e.tool === 'Bash' || e.tool === 'PowerShell') && result.deny === undefined) {
      const touched = prRefOf(result.result)
      if (touched !== null || isPush(e.command)) await fetchPr($, true, true, touched)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The engine measures after each main-thread turn and when a window moves a point.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await apply($, e)
    if (e.changed.includes('context')) await record($, e.context, true)
    await fetchFable($)
    await fetchPr($, true)
    return result
  })

  // The main conversation compacted (`/compact`, the threshold, a plugin): its new size at once.
  // A subagent's own compaction, and one computed ahead of time, leave the window as it is.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      try {
        await compacted($, result.tokensAfter)
      } catch {
        // keep the last reading
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // A /clear starts a new conversation: nothing is cached for it yet, and its trend starts over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, lastSentAt, () => null)
      await update($, warnedFor, () => null)
      await update($, history, () => [])
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Link } = $.ui.resolve(e)

    // Left: usage.
    const now = await $.clock.now()
    const r = current((await read($, reading)) ?? {}, now)
    const resets = untilText(r.fiveHourResetsAt, now)
    const points = await read($, history)

    // Context as Token Weather: forecast, tokens of the window, the last turn's growth.
    const weather = (withTrend: boolean): Part[] => {
      if (r.context === undefined) return [{ text: 'Context --', dim: true }]
      const f = forecastFor(r.context)
      const parts: Part[] = [{ text: `${f.icon} ${f.word} ${percentText(r.context)}`, color: f.color, bold: true }]
      if (r.contextTokens !== undefined && r.contextWindow !== undefined) {
        parts.push({ text: `  ${shortTokens(r.contextTokens)}/${shortTokens(r.contextWindow)}`, dim: true })
      }
      const trend = trendText(points)
      if (withTrend && trend) parts.push({ text: `  ${trend}`, dim: true })
      return parts
    }
    const limit = (text: string, percent: number | undefined): Part[] => [
      { text, color: isHot(percent) ? 'error' : undefined, dim: !isHot(percent) },
    ]
    // Fable's weekly window, before the week, once the account reports one.
    const limits = [
      limit(`5h ${percentText(r.fiveHour)}${resets ? ` (resets in ${resets})` : ''}`, r.fiveHour),
      ...(r.fable !== undefined ? [limit(`${FABLE} ${percentText(r.fable)}`, r.fable)] : []),
      limit(`Week ${percentText(r.weekly)}`, r.weekly),
    ]
    const row = (groups: Part[][]): Part[] => groups.flatMap((g, n) => (n > 0 ? [{ text: SEP, dim: true }, ...g] : g))
    const textOf = (parts: Part[]) => parts.map(p => p.text).join('')

    // A narrow body drops the trend before it wraps.
    let usageParts = row([weather(true), ...limits])
    if (cellWidth(textOf(usageParts)) > e.props.bodyColumns) usageParts = row([weather(false), ...limits])
    const usageText = textOf(usageParts)
    const usage = usageParts.map((p, n) => (
      <Text key={`u${n}`} color={p.color} dimColor={p.dim ?? false} weight={p.bold ? 'bold' : 'regular'}>
        {p.text}
      </Text>
    ))

    // Right: the pull requests, each a link to its page (the current branch's first), then the cache countdown.
    const side: { text: string; node: RenderChildren }[] = []
    for (const open of await read($, prs)) {
      const text = prText(open)
      side.push({
        text,
        node: (
          <Link key={`pr${open.number}`} href={open.url}>
            <Text color={PR_MARK[open.kind].color}>{text}</Text>
          </Link>
        ),
      })
    }
    // The countdown, once the main loop has sent a request: the time alone, yellow in the
    // last five minutes, red in the last one and once it has run out, where it stays 00:00.
    const sent = await read($, lastSentAt)
    if (sent !== null) {
      const left = sent + TTL_MS - now
      const text = mmss(left)
      const color = left <= RED_MS ? 'error' : left <= WARN_MS ? 'warning' : 'subtle'
      side.push({
        text,
        node: (
          <Text key="cache" color={color} weight={left <= WARN_MS ? 'bold' : 'regular'}>
            {text}
          </Text>
        ),
      })
    }
    const sideText = side.map(p => p.text).join(SEP)
    const cache =
      side.length === 0
        ? null
        : side.flatMap((p, n) =>
            n > 0
              ? [
                  <Text key={`s${n}`} dimColor>
                    {SEP}
                  </Text>,
                  p.node,
                ]
              : [p.node],
          )

    const fits = cache === null || cellWidth(usageText) + 2 + cellWidth(sideText) <= e.props.bodyColumns

    // The second row: the session's name, once it has one.
    const name = await read($, title)
    const nameNode =
      name === null ? null : (
        <Text key="name" dimColor wrap="truncate-end">
          {name}
        </Text>
      )

    const band = fits ? (
      <Box key="rows" flexDirection="column">
        <Box key="row" flexDirection="row" justifyContent="space-between">
          <Box key="usage" flexDirection="row">
            {usage}
          </Box>
          {cache === null ? null : (
            <Box key="cache" flexDirection="row">
              {cache}
            </Box>
          )}
        </Box>
        {nameNode === null ? null : (
          <Box key="name" flexDirection="row">
            {nameNode}
          </Box>
        )}
      </Box>
    ) : (
      // Too narrow for one row: the pull requests and the countdown go right of the name, or under it.
      <Box key="rows" flexDirection="column">
        <Box key="usage" flexDirection="row">
          {usage}
        </Box>
        {nameNode !== null && cellWidth(name ?? '') + 2 + cellWidth(sideText) <= e.props.bodyColumns ? (
          <Box key="cache" flexDirection="row" justifyContent="space-between">
            {nameNode}
            <Box key="side" flexDirection="row">
              {cache}
            </Box>
          </Box>
        ) : (
          <Box key="more" flexDirection="column">
            {nameNode === null ? null : (
              <Box key="name" flexDirection="row">
                {nameNode}
              </Box>
            )}
            <Box key="cache" flexDirection="row" justifyContent="flex-end">
              {cache}
            </Box>
          </Box>
        )}
      </Box>
    )

    // The band is shared: keep what the plugins beneath draw under this one.
    return (
      <Box flexDirection="column">
        {band}
        {await next(e)}
      </Box>
    )
  })
}

/** The account's weekly rate-limit window: the same in every session, so kept across sessions. */
export type Limits = {
  weekly?: number
  weeklyResetsAt?: string
  /** Fable's own weekly window, from the account's usage endpoint. */
  fable?: number
  fableResetsAt?: string
}

export type Reading = Limits & {
  context?: number
  contextTokens?: number
  contextWindow?: number
}

/** One context reading after a main-loop turn, for the Token Weather trend. */
export type Point = {
  tokens: number
  window: number
}

/** Milliseconds since the epoch, or null before the first main-loop request. */
export type Stamp = number | null

/** A pull request, in one of the four states the band draws. */
export type Pr = {
  /** Its checks are still running; they passed and it can be merged; it waits in the merge queue; it is merged. */
  kind: 'running' | 'ready' | 'queued' | 'merged'
  number: number
  /** Its page on GitHub: what a click on it opens. */
  url: string
}

declare module 'claude-code' {
  interface PluginState {
    'windsock-mod-ultra': {
      reading: Reading | null
      /** The last turns' context readings, oldest first. */
      history: Point[]
      /** When the main loop last sent a request to the model. */
      lastSentAt: Stamp
      /** The `lastSentAt` the five-minute warning was already raised for. */
      warnedFor: Stamp
      /** The pull requests to draw: the current branch's first, then the others still open. */
      prs: Pr[]
      /** Pages of the open pull requests this session's branches had, newest first. */
      held: string[]
    }
  }
}

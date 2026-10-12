import type { EngineInterface, Register, Timer } from 'claude-code'

const TOOL_NAME = 'compact_here'

const DEFAULTS = {
  minTokens: 60_000,
  idleMinutes: 50,
  idleMinTokens: 150_000,
}

/** Waits this long after a turn ends before compacting, so the turn is fully over. */
const SETTLE_MS = 500

const DESCRIPTION = [
  'Compact this conversation right after the current turn ends, keeping what `instructions` names.',
  '',
  'Call it at a boundary you recognise from the work itself, not from the token count: an investigation',
  'reached its conclusion, a ticket or commit is done, a research question was answered, or the topic is',
  'about to change, and the detail gathered on the way (file contents, search results, tool output, dead',
  'ends) will not be needed verbatim for what comes next.',
  '',
  'Do not call it mid-task, when the next step needs that detail, or when the user is likely to ask about',
  'what you just read.',
  '',
  'In `instructions`, say what the summary must keep: conclusions, hypotheses with their evidence,',
  'decisions with their reasons, open questions, the next step, and the file paths / URLs / commit ids to',
  're-read for detail. Then finish your answer normally.',
].join('\n')

const IDLE_INSTRUCTIONS = [
  'The session went idle and is compacted before its prompt cache expires.',
  'Keep conclusions, hypotheses with their evidence, decisions with their reasons, open questions, the',
  'next step, and every file path / URL / commit id needed to re-read details. Summarize file contents',
  'and tool output instead of quoting them.',
].join(' ')

type State = {
  /** `$.session.compact` is not available in a headless (-p / SDK) session yet */
  isInteractive: boolean
  toolName: string
  /** compact_here's instructions, waiting for the turn to end */
  pending: string | null
  idleTimer: Timer | null
}

/**
 * self-compact: compaction driven by the work, not by the token count.
 *
 * - `compact_here`: a tool the model calls at a natural boundary. The call only queues; the
 *   compaction runs once the turn has ended, with the model's own instructions.
 * - idle compaction: when the main conversation has sat idle for `idleMinutes` and is large,
 *   compact it while its prompt cache is still warm, so coming back does not rebuild the whole
 *   context at cache-write prices.
 */
export const register: Register = (on, options) => {
  const minTokens = numberOr(options.minTokens, DEFAULTS.minTokens)
  const idleMs = numberOr(options.idleMinutes, DEFAULTS.idleMinutes) * 60_000
  const idleMinTokens = numberOr(options.idleMinTokens, DEFAULTS.idleMinTokens)
  const isIdleEnabled = options.idleCompact !== false

  const state: State = { isInteractive: false, toolName: '', pending: null, idleTimer: null }

  on('session.start', async ($, e, next) => {
    state.isInteractive = e.isInteractive

    if (!state.isInteractive) {
      return next(e)
    }

    const registered = await $.tool.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          instructions: {
            type: 'string',
            description:
              'What the summary must keep (conclusions, evidence, decisions, open questions, next step, paths/URLs to re-read).',
          },
        },
        required: ['instructions'],
      },
    })

    state.toolName = registered.tool

    return next(e)
  })

  // A plugin's tools wait behind ToolSearch by default; the model has to see this one to use it.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)

    return e.tool === state.toolName ? { ...described, isDeferred: false } : described
  })

  on('tool.call', async ($, e, next) => {
    if (state.toolName === '' || e.tool !== state.toolName) {
      return next(e)
    }

    if (e.agentId !== undefined) {
      return { deny: 'compact_here compacts the main conversation; a subagent cannot call it.' }
    }

    const { context } = await $.session.usage()
    const tokens = context.tokens ?? 0

    if (tokens < minTokens) {
      return {
        result: `Not queued: the context is about ${kilo(tokens)} tokens, below the ${kilo(minTokens)} worth compacting. Carry on.`,
      }
    }

    // A plugin tool's arguments arrive loose on `e`, beside `tool` and `tool_use_id`.
    const { instructions } = e as Readonly<Record<string, unknown>>
    const written = typeof instructions === 'string' ? instructions.trim() : ''

    state.pending = written === '' ? IDLE_INSTRUCTIONS : written

    return {
      result: `Queued: the conversation (about ${kilo(tokens)} tokens) will be compacted right after this turn ends, keeping what your instructions name. Finish your answer normally and tell the user in one line that it will be compacted.`,
    }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    cancelIdle(state)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (!state.isInteractive || e.agentId !== undefined) {
      return done
    }

    cancelIdle(state)

    if (state.pending !== null) {
      const instructions = state.pending

      state.pending = null

      if (!e.isAborted) {
        $.clock.after(SETTLE_MS, () => void compact($, state, instructions, 'compact_here'))
      }

      return done
    }

    if (isIdleEnabled) {
      state.idleTimer = $.clock.after(idleMs, () => void compactIfLarge($, state, idleMinTokens))
    }

    return done
  })
}

/**
 * Compacts the conversation and says so in a toast. A compaction refused because a turn is running
 * keeps compact_here's instructions for the end of that turn.
 */
async function compact($: EngineInterface, state: State, instructions: string, label: 'compact_here' | 'idle') {
  try {
    const out = await $.session.compact({ instructions })

    if ('skip' in out) {
      $.ui.toast(`self-compact: ${label} skipped (${out.skip})`)

      return
    }

    $.ui.toast(`self-compact: ${label} compacted ${kilo(out.tokensBefore)} → ${kilo(out.tokensAfter)} tokens`)
  } catch (err) {
    $.ui.log(`self-compact: ${label} could not compact now (${String(err)})`, { to: 'debug' })

    if (label === 'compact_here') {
      state.pending ??= instructions
    }
  }
}

/** The idle timer's end: compacts only a conversation still large enough to be worth it. */
async function compactIfLarge($: EngineInterface, state: State, minTokens: number) {
  state.idleTimer = null

  const { context } = await $.session.usage()

  if ((context.tokens ?? 0) >= minTokens) {
    await compact($, state, IDLE_INSTRUCTIONS, 'idle')
  }
}

function cancelIdle(state: State) {
  state.idleTimer?.cancel()
  state.idleTimer = null
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function kilo(tokens: number | undefined) {
  return tokens === undefined ? '?' : `${Math.round(tokens / 1000)}k`
}

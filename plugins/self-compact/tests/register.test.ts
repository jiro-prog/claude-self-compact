import type { On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const TOOL = 'mcp__self-compact__compact_here'
const MINUTE = 60_000
const SUMMARY: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }

const turnEnd = (turnId: string, isAborted = false) =>
  ({ answer: '', durationMs: 1, isAborted, turnId, reason: isAborted ? 'aborted' : 'answer' }) as const

/**
 * The engine beneath the plugin: a context of `size.tokens`, a compaction that records its
 * instructions (or refuses while `size.isTurnRunning`), and the toasts shown.
 */
function world(on: On, size: { tokens: number; isTurnRunning?: boolean }) {
  const compactions: (string | undefined)[] = []
  const toasts: string[] = []
  const registered: { name: string; isDeferred?: boolean }[] = []
  const clock = mock.clock(on)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [SUMMARY] as SessionMessage[] }))
  on('tool.register', ($, e) => {
    const { isDeferred } = e as { isDeferred?: boolean }
    registered.push({ name: e.name, isDeferred })

    return { value: { tool: `mcp__self-compact__${e.name}` } }
  })
  on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: size.tokens, window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.compact', ($, e) => {
    if (size.isTurnRunning === true) {
      throw new Error('a turn is running')
    }

    compactions.push(e.instructions)

    return { messages: [SUMMARY], tokensBefore: size.tokens, tokensAfter: 20_000 }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { compactions, toasts, registered, clock }
}

describe('compact_here', () => {
  test('is registered in front of the model, not behind ToolSearch', async ($, on) => {
    const w = world(on, { tokens: 200_000 })
    await $.session.start(SESSION)

    expect(w.registered).toEqual([{ name: 'compact_here', isDeferred: false }])
  })

  test('stays in front when the engine describes it', async ($, on) => {
    world(on, { tokens: 200_000 })
    await $.session.start(SESSION)

    const described = await $.tool.describe({
      tool: TOOL,
      description: 'd',
      isDeferred: true,
      provider: { plugin: 'self-compact', tier: 'user' },
    })

    expect(described.isDeferred).toBe(false)
  })

  test('compacts with the model\'s instructions once the turn has ended', async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    await $.session.start(SESSION)

    const called = await $.tool.call({ tool: TOOL, instructions: 'keep the hypothesis and its evidence' })

    expect(String(called.result)).toContain('Queued')
    expect(w.compactions).toEqual([])

    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.compactions).toEqual(['keep the hypothesis and its evidence'])
    expect(w.toasts.join('\n')).toContain('300k → 20k')
  })

  test('does not queue a small conversation', async ($, on) => {
    const w = world(on, { tokens: 30_000 })
    await $.session.start(SESSION)

    const called = await $.tool.call({ tool: TOOL, instructions: 'keep it' })

    expect(String(called.result)).toContain('Not queued')

    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.compactions).toEqual([])
  })

  test('refuses a subagent', async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    await $.session.start(SESSION)

    const called = await $.tool.call({ tool: TOOL, instructions: 'keep it', agentId: 'sub-1' })

    expect(JSON.stringify(called)).toContain('a subagent cannot call it')

    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.compactions).toEqual([])
  })

  test('drops the request when the person interrupts the turn', async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    await $.session.start(SESSION)

    await $.tool.call({ tool: TOOL, instructions: 'keep it' })
    await $.turn.complete(turnEnd('t1', true))
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.compactions).toEqual([])
  })

  test('keeps a refused compaction for the end of the next turn', async ($, on) => {
    const size = { tokens: 300_000, isTurnRunning: true }
    const w = world(on, size)
    await $.session.start(SESSION)

    await $.tool.call({ tool: TOOL, instructions: 'keep it' })
    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.compactions).toEqual([])

    size.isTurnRunning = false
    await $.turn.complete(turnEnd('t2'))
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.compactions).toEqual(['keep it'])
  })
})

describe('idle compaction', () => {
  test('compacts a large conversation idle for 50 minutes', async ($, on) => {
    const w = world(on, { tokens: 400_000 })
    await $.session.start(SESSION)

    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(49 * MINUTE)
    await w.clock.settle()

    expect(w.compactions).toEqual([])

    await w.clock.advance(1 * MINUTE)
    await w.clock.settle()

    expect(w.compactions).toHaveLength(1)
    expect(w.compactions[0]).toContain('idle')
  })

  test('leaves a small conversation alone', async ($, on) => {
    const w = world(on, { tokens: 100_000 })
    await $.session.start(SESSION)

    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(60 * MINUTE)
    await w.clock.settle()

    expect(w.compactions).toEqual([])
  })

  test('is cancelled when the person comes back first', async ($, on) => {
    const w = world(on, { tokens: 400_000 })
    await $.session.start(SESSION)

    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(30 * MINUTE)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await w.clock.advance(30 * MINUTE)
    await w.clock.settle()

    expect(w.compactions).toEqual([])
  })

  test('ignores a subagent\'s turns', async ($, on) => {
    const w = world(on, { tokens: 400_000 })
    await $.session.start(SESSION)

    await $.turn.complete({ ...turnEnd('t1'), agentId: 'sub-1' })
    await w.clock.advance(60 * MINUTE)
    await w.clock.settle()

    expect(w.compactions).toEqual([])
  })

  test('can be turned off', { options: { idleCompact: false } }, async ($, on) => {
    const w = world(on, { tokens: 400_000 })
    await $.session.start(SESSION)

    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(60 * MINUTE)
    await w.clock.settle()

    expect(w.compactions).toEqual([])
  })
})

describe('headless session', () => {
  test('offers no tool and does no idle compaction', async ($, on) => {
    const w = world(on, { tokens: 400_000 })

    await $.session.start({ ...SESSION, isInteractive: false })
    await $.turn.complete(turnEnd('t1'))
    await w.clock.advance(60 * MINUTE)
    await w.clock.settle()

    expect(w.registered).toEqual([])
    expect(w.compactions).toEqual([])
  })
})

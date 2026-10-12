# self-compact

Context-driven compaction for [Claude Code](https://code.claude.com), as a plugin of function hooks.

Claude Code compacts a conversation when it gets full: a token count decides. This plugin adds two
triggers that the work itself decides:

- **`compact_here`** — a tool Claude calls when a phase of work has just concluded (an investigation
  reached its answer, a ticket was committed, the topic is about to change). Claude writes what the
  summary must keep; the plugin compacts right after that turn ends, with those instructions.
- **Idle compaction** — when a large conversation has sat idle for 50 minutes, it is compacted while
  its prompt cache is still warm.

## Why

Every turn re-reads the whole conversation. Most of that is a prompt-cache read, which is cheap per
token but is paid again on every model call, so a long research session that drifts to several
hundred thousand tokens costs several times more per call than a fresh one. Compacting at the point
where the detail stops mattering keeps the conversation small without losing the thread, because the
model that knows what matters chooses what to keep.

The prompt cache also expires after an hour. Coming back to a large idle conversation re-writes the
whole context into the cache at cache-write prices. Compacting shortly before that happens means only
the summary is re-written.

## Install

```sh
claude plugin marketplace add jiro-prog/claude-self-compact
claude plugin install self-compact@self-compact
```

Function hooks may need to be switched on. In `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Start a new session (or run `/reload-plugins`). Claude sees `mcp__self-compact__compact_here` in its
tool list.

## Settings

Change them in `/config` (the plugin's rows) or in `settings.json` under
`pluginConfigs["self-compact"].options`:

| Option | Default | Meaning |
| --- | --- | --- |
| `minTokens` | `60000` | `compact_here` declines below this context size |
| `idleCompact` | `true` | Compact idle conversations at all |
| `idleMinutes` | `50` | Minutes after the last turn before idle compaction; keep it under the cache lifetime (60) |
| `idleMinTokens` | `150000` | Idle compaction only at or above this context size |

To steer what every summary keeps, add a `## Compact Instructions` section to your `CLAUDE.md`; the
summarizer reads it for every compaction, this plugin's included.

## How it works

- `session.start` registers the tool with `$.tool.register({ ..., isDeferred: false })`, keeping it
  out of ToolSearch so the model reads its description; a `tool.describe` hook pins the same.
- The tool call only queues the instructions. `turn.complete` (main loop only) runs
  `$.session.compact({ instructions })` once the turn is over. A compaction refused because a new turn
  had already started is kept for the end of that turn; an interrupted turn drops it.
- The same `turn.complete` arms a timer for idle compaction; `turn.start` cancels it.
- Subagents cannot call the tool, and their turns are ignored.

## Limits

- Interactive sessions only. `$.session.compact` is not available in headless (`claude -p`, SDK)
  sessions yet, so there the plugin offers no tool and arms no timer.
- Idle compaction assumes Claude Code's one-hour prompt cache. With a five-minute cache it still
  shrinks the conversation, but the cache has already expired by then.
- Function hooks are a young Claude Code API; this was built and tested on Claude Code 2.1.296.
  Before 2.1.294, `$.tool.register` ignores `isDeferred`, and on 2.1.289 the tool still came up behind
  ToolSearch after `/reload-plugins` despite the `tool.describe` pin. The model then only sees its
  name until it loads the tool.

## Develop

```sh
claude plugin validate plugins/self-compact
claude plugin test plugins/self-compact
```

## License

MIT

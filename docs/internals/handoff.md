# Handoff is agent-driven: a shipped skill plus a CLI callback, not a server-side summarizer

Handoff moves work from a live thread to a fresh one. The obvious build (and what the groundwork
research for it recommended) was server-side: a `TextGeneration` op replaying the old session with
`claude -p -r <sessionId> --fork-session --json-schema` to produce `{ name, summary }`, then a
bootstrap turn-start. We rejected that in favor of the native shape: the server ships a **`handoff` skill**
(as a local SDK plugin injected into every session), the **live agent composes the name and summary
itself** — it already holds the full context natively — and hands them to a **`t3 handoff --name
"<name>"` CLI** (summary on stdin), which calls `POST /handoff` on the running server. The
server creates the child in the parent's project, seeds it with the summary, starts it, and records
lineage as `handoff.created` / `handoff.received` thread activities.

The CLI finds and authenticates to the server via **env injected at session spawn**:
`T3_SERVER_ORIGIN`, `T3_THREAD_ID`, a narrow-scoped `T3_SERVER_TOKEN`, and `T3_CLI` — a single
executable-shim path, never a "runtime + script" pair (zsh does not word-split unquoted
parameters). The shim itself is handed the CLI entry and the runtime to read it with
(`T3_CLI_ENTRY`, `T3_CLI_RUNTIME`), because in a packaged desktop app the server bundle stays
inside an asar archive that only the Electron binary can read (through `ELECTRON_RUN_AS_NODE`). The token is the session's existing MCP bearer credential (`McpSessionRegistry`):
already per-thread, already expiring, already revoked when the session stops — and it _resolves
to_ the parent thread server-side, so lineage identity comes from the credential and cannot be
confused. The skill ships as the `handoff` skill of the T3-owned local plugin (SDK `plugins`
option), invoked plugin-qualified as `t3:handoff`.

## Considered options

- **Server-side summarizer (fork-session replay, projection fallback)**: rejected. It duplicates
  what the live agent does natively but worse — a 180 s timeout risk on long sessions, an
  instance-resolution trap (`textGenerationModelSelection` may point at a different
  `CLAUDE_CONFIG_DIR` than the thread's transcript), untracked token spend in no thread's usage,
  and a lossy projection fallback. The agent-driven shape deletes all four problems and keeps the
  skill's prompt rules (redaction, suggested skills, reference-don't-duplicate) where they run best.
- **Review-before-launch UI**: rejected for v1 — handoff is background-and-immediate (background-and-immediate). The agent's confirmation message in the parent, with a link to the child, is the
  receipt. Redaction stays best-effort skill instruction.
- **CLI self-issuing tokens from the shared SQLite state dir**: rejected — a second process writing
  the live auth DB, and no way to know the parent thread id for lineage.

## Consequences

Handoff only happens _from_ a live session — there is no path for a dead thread (accepted: with no
live agent there is nothing that knows the work well enough to summarize it cheaply). The child is
a first-class thread: same notifications and inbox behavior as a user-prompted one — in particular
its seed turn counts as **user-initiated** for the turn-completed notification kind. The parent is
left untouched (no auto-settle/snooze). Lineage lives in thread activities (detail view), not the
sidebar shell; chain UI would require promoting it to a shell field.

## Packaging

`claude` is a plain subprocess and cannot read an asar archive, so the plugin directory handed to
the SDK must be real files: desktop builds unpack `apps/server/dist/claude-plugin` (electron-builder
`asarUnpack` on macOS/Linux, the `server.asar` sidecar's `unpackDir` on Windows), and
`resolveT3ClaudePluginLocation` returns the `.unpacked` twin whenever the plugin resolves inside an
archive. Packed with no twin it returns nothing and logs a warning rather than handing over a path
that exists only for the server: skill discovery reads through the same asar-aware fs, so otherwise
`t3:handoff` shows up in the picker while loading nowhere.

## Providers

v1 is Claude-only, delivered through the Claude adapter's plugin and env wiring; skill discovery is plugin-aware so `t3:handoff` appears in the skill picker. Codex, Cursor, Grok, and OpenCode are explicitly unsupported in v1 — no plugin or skill-injection equivalent is wired for them. The HTTP route and handoff service are provider-neutral, so adding an adapter later is env injection plus a skill-delivery mechanism, not a redesign.

# Kimi Code

Kimi Code runs as a local CLI on the machine that hosts your T3 Code server. T3 Code starts
`kimi acp` and talks to it over the Agent Client Protocol.

## Install and sign in

1. Install the Kimi Code CLI on the server machine and sign in once:

```bash
kimi --version
kimi login
```

`kimi login` opens a device-code flow in a terminal. T3 Code never starts this flow on its own.

2. In T3 Code, open **Settings > Providers** and enable Kimi Code. It ships disabled, like
   Cursor and Grok.

Self-hosting on a container or remote box works like any other provider: install `kimi` there,
run `kimi login` there, and connect from web, desktop, or mobile. The CLI runs where the server
runs.

## What works in a thread

- **Models.** Pick a model from the thread's model picker. Kimi's models (K2.8 Preview, K3, and
  any provider you added with `kimi provider`) appear automatically. Switching models between turns
  takes effect without a restart.
- **Plan mode.** Use the thread's Plan/Build toggle. Plan maps to Kimi's read-only Plan mode.
- **Sub-agents.** When Kimi dispatches an `Agent` or an `AgentSwarm`, the thread shows a spawn
  row. Kimi keeps sub-agent work isolated, so you see the dispatch and the final result, not the
  inner tool calls.
- **Questions.** When Kimi asks you a question or requests a tool approval, the thread shows the
  same question panel and approval controls as other providers.

## Commands

Type `/` in the composer to see Kimi's remote commands, for example `/compact`, `/status`,
`/usage`, `/tasks`, and your Kimi skills. Commands that only make sense inside the Kimi terminal
UI, such as `/theme`, are not offered.

## Known limits

- Kimi's `/goal` and `/plan` commands are terminal-only (confirmed through Kimi Code CLI 2.0.x)
  and are not reachable from T3 Code. Typing them anyway makes Kimi answer with an
  "Unknown ACP command" error. For plan mode use the thread's Plan/Build toggle, which maps to
  Kimi's Plan mode. For goals, ask for one in plain language ("create a goal for ...") — the
  CreateGoal tool works over ACP.
- Kimi has no separate "accept edits" permission level. The approval modes map to Kimi's
  Default, Auto, and YOLO modes.
- Updates are manual: run `kimi upgrade` on the server machine.

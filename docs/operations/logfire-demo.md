# Logfire agent demo

For the reproducible title-generation investigation, use the
[title-pipeline T3 demo](../../demos/logfire-titles/README.md). It includes recorded
Luna titles, a fresh runtime evaluation, and the Logfire MCP investigator handoff.

Use `demo/logfire-live` with Node 24, `vp`, and an authenticated Codex or Claude CLI.
This branch records agent turns, model responses, tool calls, and subagents. It does
not record or export background server/browser traces, write a local trace file,
or export application metrics and logs. Server diagnostics still print to stdout.
No Logfire SQL filter is needed.

## Start

From a fresh checkout of the branch:

```sh
vp i
cp docs/operations/logfire-demo.env.example .env.local
```

Replace `<write token>` in `.env.local` with a write token for your Logfire project.
The template uses the US region. Use your project's regional trace endpoint if it
is elsewhere. Message and tool content capture is enabled so the demo includes
prompts, responses, arguments, and results. Keep `.env.local` private; it is ignored
by Git.

```sh
vp run dev
```

Open the full pairing URL printed by the runner, then open the same Logfire project
in another tab. The runner creates a project and an empty thread for this checkout.
In a linked worktree, data stays under `.t3/userdata`; a main checkout uses the dev
home described in [Development](development.md#state-and-ports).

## Exercise the trace

Start a new Codex or Claude thread in T3 Code and send:

> Run `git status --short --branch`, then read `package.json` and summarize the
> available development commands. Do not modify files.

Watch Logfire Live or Agents. Open the agent's **Agent Run** tab for its observed
conversation, including intermediate replies and tool calls. Prompts and completed
assistant messages also appear in Live while the agent is running. MCP calls inside
Codex's `exec` wrapper are nested tools with native argument and result fields.
Long operations appear before they finish. A fresh Codex thread
provides the richest model/tool detail; resumed Codex threads have less timing
information. Captured messages cover the current turn, not the provider's hidden
system instructions or full request history. Text is capped at 32,000 characters
per message and 16,000 per structured tool string; truncated values are marked.

The view is empty while idle. Old background records already in the Logfire project
remain in history; move the time range past the restart or use a fresh project.
Restarting with `vp run dev` reuses your local project, thread history, and config.
To repeat the demo, start another new thread rather than deleting the database.

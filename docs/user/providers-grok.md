# Grok Build

This guide is for people who want to use Grok Build in T3 Code. For first-time setup, see
[Install T3 Code](./install.md).

Log in with the Grok CLI on the machine that runs the T3 Code server:

```bash
grok login
```

You can also set `XAI_API_KEY` in the server environment instead of running `grok login`.
Background provider checks start ACP with browser login disabled (`CI` / `NO_BROWSER`). If
authenticate fails, Settings shows an unauthenticated status and asks you to run `grok login`.

In T3 Code Settings, the default Grok provider can stay like this:

```text
Display name: Grok
Binary path: grok
```

Use an explicit binary path when `grok` is not on the `PATH` of the shell that started T3 Code.

## Models and effort

T3 Code reads the live Grok model list from the CLI. Current Grok Build installs advertise
`grok-4.6` and `grok-4.5`. The product slug `grok-build` is treated as an alias for the session's
current ACP model — T3 does not send it to `session/set_model`. Each model that supports reasoning
effort shows a Reasoning control in the composer. The menu comes from the CLI, so the levels can
differ by model.

T3 Code sends the selected effort on the live session. You do not need a new thread to change
model or effort.

## Plan mode

The composer Plan / Default control is on for Grok. T3 sends `session/set_mode` for the
matching advertised ACP mode (`plan` / `architect` for Plan, `code` / `agent` for Default).
ACP `plan` entries already update the turn plan list. `/plan` and `/default` in the composer
are the same control.

## Workflows

Grok Build workflows are Rhai scripts that orchestrate child agents as one background run. The
CLI launches them with the `workflow` tool or `/workflow` and streams progress as
`x.ai/session_notification` / `workflow_updated`.

T3 Code now maps those updates onto the same Agents / task surface used by Claude workflows and Codex collab children:

- the run becomes a `local_workflow` task (name, objective, phases)
- each child agent becomes a `subagent` task with `parentAgentId` + `timelineBypass` (not a parent-timeline row)
- member tokens stay on the child `typedUsage` snapshot — they do not replace the thread context window
- standalone Grok `subagent_spawned` / `subagent_progress` / `subagent_finished` updates use the same child-task path

T3 does not reimplement the Rhai host. Composer `/` lists `/workflow pause`, `/workflow resume`,
`/workflow stop`, and each script in `~/.grok/workflows` plus the project `.grok/workflows`
directory. Picking one sends that slash text as a prompt so the Grok CLI can run it. Project
scripts override user scripts of the same name.

## Usage

After each prompt T3 reads Grok's prompt `_meta.usage` (including the official PromptUsage
totals / `cached_read_tokens` shape) and emits `thread.token-usage.updated`. Workflow child
tokens are added as they arrive.

The Usage page scans `~/.grok/sessions/**/updates.jsonl` the same way it reads Claude and
Codex transcripts. Complete PromptUsage rows contribute token totals and, when
`costUsdTicks` is present and the bill is not marked incomplete, a dollar amount
(1e10 ticks = $1). Incomplete bills stay on the token side and never become $0.

Live turns do the same: a complete `turn_completed` PromptUsage row updates the
context window and, when the bill is complete, attaches `totalCostUsd` to the
turn. Auto-compact notifications fill the context-window meter
(`compactsAutomatically`) and mark the thread compacted, matching Claude's
compact boundary. Session recap lands on thread metadata, not the title.
Hook runs and background shells use the same `hook.*` and `local_bash` task
events as Claude. Queued prompts (`_x.ai/queue/changed`) update session state
and thread metadata with the queue length.

## Rewind

Conversation rollback uses Grok's `_x.ai/rewind` extension. T3 maps "undo N turns" onto rewind
points from the remaining conversation, so a cancelled in-flight prompt cannot leave Grok and T3
on different histories, then trims the in-memory turn list when execute succeeds.

## If Grok looks ready but will not start

Run `grok login` again on the server machine. T3 Code reports an unauthenticated Grok install in
Settings when ACP login fails.

## What T3 still does not surface

Grok Build's ACP session channel also carries plugins and marketplace updates. Those
notifications are accepted and ignored until a later change maps them. The Grok CLI TUI
remains the source of truth for `/usage`.

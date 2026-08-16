# Grok Build

This guide is for people who want to use Grok Build in T3 Code. For first-time setup, see
[Install T3 Code](./install.md).

Log in with the Grok CLI on the machine that runs the T3 Code server:

```bash
grok login
```

You can also set `XAI_API_KEY` in the server environment instead of running `grok login`.
Background provider checks do not start a Grok browser login. If the CLI is installed but has no
saved credentials, Settings shows an unauthenticated status and asks you to run `grok login`.

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

## Workflows

Grok Build workflows are Rhai scripts that orchestrate child agents as one background run. The
CLI launches them with the `workflow` tool or `/workflow` and streams progress as
`x.ai/session_notification` / `workflow_updated`.

T3 Code now maps those updates onto the same Agents / task surface used by Claude workflows and Codex collab children:

- the run becomes a `local_workflow` task (name, objective, phases)
- each child agent becomes a `subagent` task with `parentAgentId` + `timelineBypass` (not a parent-timeline row)
- member tokens stay on the child `typedUsage` snapshot — they do not replace the thread context window
- standalone Grok `subagent_spawned` / `subagent_progress` / `subagent_finished` updates use the same child-task path

Slash commands such as `/workflow pause|resume|stop` still belong to the Grok CLI session. T3
does not reimplement the Rhai host. It consumes the ACP notifications the host already emits.

## Usage

After each prompt T3 reads Grok's prompt `_meta.usage` (including the official PromptUsage
totals / `cached_read_tokens` shape) and emits `thread.token-usage.updated`. Workflow child
tokens are added as they arrive.

Cost ticks (`costUsdTicks`) are not billed in T3 yet. Incomplete or partial Grok bills are
treated as token counts only.

## Rewind

Conversation rollback uses Grok's `_x.ai/rewind` extension. T3 maps "undo N turns" onto rewind
points and trims the in-memory turn list when execute succeeds.

## If Grok looks ready but will not start

Run `grok login` again on the server machine. T3 Code reports an unauthenticated Grok install in
Settings when ACP login fails.

## What T3 still does not surface

Grok Build's ACP session channel also carries plan mode, goals, queue, hooks, plugins,
marketplace updates, auto-compact, monitors, and scheduled tasks. Those notifications are
accepted and ignored until a later change maps them. The Grok CLI TUI remains the source of
truth for `/workflows`, `/plan`, and `/usage`.

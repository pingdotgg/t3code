# Workflows

A workflow is a TypeScript script that chains agents, plain code, schedules, webhooks, issue and pull request events, and questions to you into one durable run that survives server restarts. Each step's result is saved when it succeeds, so restarts pick up where the run left off and failures do not lose earlier work. Workflows are an early feature: start runs from the `t3` CLI or a trigger, and follow them in the app.

For one prompt on a timer or webhook, use a scheduled task. Use a workflow when work has stages — such as triage, a fix, your approval, and a release.

## Create a workflow

Workflow files live in `~/.t3/workflows/` (or wherever `T3CODE_WORKFLOWS` points — a folder or a single file). Nothing needs to be enabled; the server watches the folder and reloads changes without a restart.

- **Ask an agent (recommended):** copy the [`t3-workflows` skill](../../skills/t3-workflows/SKILL.md) into your agent's skills folder (such as `~/.claude/skills/` or `~/.agents/skills/`) and describe what you want.
- **Edit directly:** edit files in `~/.t3/workflows/`, or use **Definitions** on the Workflows page (saving and deleting in the app require terminal access).

Saving checks that the file loads, does not duplicate a workflow name and version, and does not remove a version with unfinished runs. A broken file does not stop other workflows: its last working version keeps running while the Workflows page shows the error. Mistakes inside a workflow body surface when a run hits them and pauses. To change steps while runs are unfinished, add the new body under a higher `version` and keep the old one until those runs end.

Dot-files and subfolders are ignored. Keep shared helpers in a subfolder and restart the server after editing an imported file.

## Start and steer

```sh
t3 workflow start <name> --input '<json>' --key <key>
t3 workflow list
t3 workflow show <run>
t3 workflow resume <run>
t3 workflow cancel <run>
t3 workflow questions
t3 workflow signal '{"choice":"yes"}' --run <run> --wait <name>
t3 workflow signal '<json>' --workflow <name> --channel <channel>
t3 workflow hooks
t3 workflow store list
t3 workflow store set <key> '<json>'
```

Starting twice with the same `--key` returns the same run — even after a version bump — so retries do not duplicate work. Use `signal` with `--run` and `--wait` to answer a question or wake a run, or with `--workflow` and `--channel` to wake whichever run waits on that channel. Use `store` to read or change state kept between runs.

## Triggers

- **Schedules:** `every` runs on an interval; `daily` runs at a local time of day (a time missed by more than 10 minutes while the server is down is skipped).
- **Webhooks:** `t3 workflow hooks` prints each hook's path; prepend your server's address (the same origin scheduled task webhooks use). The path contains the hook's secret, so share it only with the sender. Organization policies blocking webhook tasks block workflow webhooks too.
- **Issues and pull requests:** workflows can start on new issues or pull requests and read, comment on, or update them via **Settings → Source control & issues** — no webhook needed. T3 Code checks roughly once a minute, and only items opened after the workflow was first loaded start runs.

## Follow runs in the app

Once a server has runs, **Workflows** appears in the sidebar with a count of open questions and paused runs waiting on you; on mobile, use the **Workflows** tab. Filter by **Needs you**, **Running**, or **All** (skipped runs stay hidden unless toggled on), open child runs from their parent, and answer questions, resume paused runs, or cancel active runs (requires permission to operate threads).

### Agent threads

Each `agent` step runs in an ordinary thread hidden from the main thread list. Open it from the run to watch it live, read its transcript, or send follow-up messages; the thread links back to the run.

An `agent` step can launch a new thread with its own `workspace` (such as a worktree), `runtimeMode`, `interactionMode`, `title`, and typed `returns`, or continue an earlier step's thread. Runs can set their display name with `title(text)`. An `agent` step can also target a project on a [linked environment](remote-access.md#link-another-environment) (requires **Settings → Labs → Linked environments**); the run itself stays on the server that started it.

### Failures, pause, and cancel

A plain code step runs once unless it asks for retries. When a step fails, the run pauses there instead of losing earlier work:

- **Code step failures** retry automatically after 5, 20, and 80 minutes by default, or immediately when you resume; only that step runs again.
- **Agent failures** — when an agent ran and gave up or timed out — pause and wait for you to resume rather than retrying automatically. An agent that could not be started at all, for example because its environment was offline, retries on its own like a failed step.

Cancelling a run stops its active agent turns and cancels child runs it invoked. A cancelled run cannot be resumed.

## Limits

- Runs live on the server that started them and only advance while it is running; use an always-on machine for schedules or webhooks you cannot miss.
- Keep older workflow versions defined until their unfinished runs end or are cancelled.
- Signals sent to a `channel` before a run waits on it are kept for 7 days by default.

# Pi

Run your existing [Pi](https://pi.dev) (**0.84.3+**, Node.js **22.19+**) installation in T3 Code while keeping Pi's models, auth, extensions, skills, and native session history.

## Set up Pi

1. Install Pi on the server machine (via Pi's installer or `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`).
2. Run `pi` and `/login` in a terminal on the server (over SSH for remote hosts, or set your model provider's API key in the Pi instance's environment variables).
3. Open **Settings → Providers**, enable **Pi**, and refresh. Set **Binary path** if `pi` isn't on `PATH`.

- In **Launch arguments**, `--provider` must be paired with `--model`. Flags that alter Pi's execution mode or session selection are rejected because T3 Code manages them.
- Update installer-managed Pi with `pi update`, or via your package manager (e.g. `nix profile upgrade pi`).

## Features and extensions

- **Models, thinking & speed**: Discovers Pi models, thinking levels, and `serviceTiers` (exposed as a speed picker).
- **Native sessions**: Resume, rollback, and same-instance forks use Pi's native session files; switching providers uses a [portable handoff](./portable-handoffs.md).
- **Skills & extensions**: Pi user and trusted project skills appear in `$`. Extension `select`, `confirm`, `input`, and `editor` dialogs render in the composer, notifications appear in the activity log, and status text appears near the composer.
- **Subagents**: T3 Code's `delegate_task` creates full child threads; Pi's example `subagent` extension also displays task progress/results (read-only).

## Permission modes

- **Supervised**: Asks before commands, file edits, and extension tools (reads proceed).
- **Auto-accept edits**: Allows Pi's edit/write tools; asks for commands and extension tools.
- **Full access**: Allows all tool calls without prompts.

## Shared Inference Accounts

Pi 1.4.0 or newer can use accounts on an [inference host](./providers-claude.md#host-and-share-inference-accounts)
alongside its own logins. In **Settings > Inference accounts**, choose **Pi** beside the host,
or turn on **Inference routing** in Pi's provider settings. Pi can use every model the host serves,
including models from accounts other than Claude and Codex.

Choose a `t3proxy/<model-id>` model to send its requests through the host. Pi's native models,
logins, extensions, and configuration remain available. Tools, files, and thread history stay on
the environment running Pi; the host manages the accounts used for the model requests.

Choose the route again in Settings to refresh the model list after changing the host's accounts.
Turn off **Inference routing** to stop adding the host's models to Pi.

In a terminal opened for the routed Pi provider in T3 Code, load the host's models with:

```sh
pi --extension "$T3_PI_INFERENCE_EXTENSION"
```

T3 Code supplies that extension path to the provider's terminal. It does not change Pi's
configuration for other shells.

## What Carries Over

T3 Code discovers the models reported by Pi and exposes their supported thinking levels. The
thinking picker marks the discovered active model's configured level as its default without
overriding it. Other models keep their Pi defaults when no level is selected. A model that lists
`serviceTiers` (for example `[{ "id": "priority", "name": "Fast" }]`) in its Pi definition gets
a speed picker with Standard plus those tiers. A chosen tier is sent as the request's
`service_tier`; Standard sends none and leaves the endpoint's default. Threads
use Pi's native session files for resume, rollback, and forks within the same Pi instance. Forks
preserve the native conversation through the selected turn in the destination workspace.
Switching providers uses portable conversation context. Extension
dialogs appear in the T3 Code composer, and the thread details context window follows Pi's own usage
reporting while a response streams and after it settles.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi loads its normal user extensions, and project extensions once the folder is trusted in Pi.
Blocking `select`, `confirm`, `input`, and `editor` dialogs work in T3 Code. Notifications appear in
the work log. Extensions can publish status text near the composer. Terminal titles and generic
widgets do not have a T3 Code equivalent.

## Permission Modes

T3 Code applies the composer permission mode through Pi's blocking tool hook:

- **Supervised** asks before commands, file changes, and extension tools. Read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, but asks before commands and extension
  tools.
- **Full access** allows tools without T3 Code approval prompts.

The **Auto** option is not shown for Pi because Pi does not expose an AI approval reviewer.
Threads that already stored Auto before Pi support was added behave and display as Supervised.

Changing the mode restarts the Pi provider session and resumes the same native conversation. The
policy covers Pi tool calls; it is not an operating-system sandbox, and code that a trusted Pi
extension runs outside a tool call remains governed by Pi's own extension trust model.

T3 Code's `delegate_task` tool creates durable child threads in the shared subagent UI. If the user
installs Pi's example `subagent` extension, T3 Code also shows its task progress and results in that
UI. Pi runs those children without a session, so they cannot be opened or resumed as T3 Code
threads. The example extension also starts each child without T3 Code's injected tool and
permission bridge: those children do not receive project memory, conversation summaries, code
graph, other T3 tools, or T3 permission prompts. Use `delegate_task` for child work that needs
these integrations. Other extensions that start separate Pi processes need to provide their own
child integration; showing a child's progress in T3 Code does not mount its tools.

## Troubleshooting

- **Untrusted project folder**: If Pi skips project extensions/skills/MCP, run `pi` in that folder on the server (with the same `PI_CODING_AGENT_DIR` if set), run `/trust`, and start a new thread in that worktree. Add `--no-approve` to launch arguments to keep project files disabled without the notice.
- **Discovery fails**: T3 Code keeps Pi usable with `Pi default` so an interactive session can handle startup prompts.
- **Context window**: Enable **Settings → Appearance → Thread details → Context window** (some model providers report usage only after the first reply completes).

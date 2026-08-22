# Kimi

T3 Code can run agents on Moonshot AI's Kimi models (K3, Kimi K2.7 Coding) through the official
Kimi CLI. For first-time setup of T3 Code itself, see [Install T3 Code](./install.md).

## Requirements

- The Kimi CLI (`kimi`) installed and on your PATH. Use the official install script
  ([full instructions](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)):

  ```bash
  # macOS / Linux
  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
  # Windows (PowerShell)
  irm https://code.kimi.com/kimi-code/install.ps1 | iex
  ```

  or npm: `npm install -g @moonshot-ai/kimi-code`

  Binary resolution uses an explicit provider Binary path first, then the official
  `~/.kimi-code/bin/kimi` install (`kimi.exe` on Windows), then `kimi` from PATH.

- On Windows, the Kimi CLI requires [Git for Windows](https://git-scm.com/downloads/win) for its
  shell environment. If Git Bash is installed in a custom location, set the `KIMI_SHELL_PATH`
  environment variable to your `bash.exe`.
- A Kimi account with a Kimi For Coding subscription.

## Enable and Sign In

Kimi is off by default. Open Settings → Providers, find the Kimi provider, and switch it on.

You can then sign in from inside T3 Code: press **Sign in with Kimi** on the same provider card. Approve the sign-in in your browser (the shown code must match), and the
provider flips to authenticated on its own.

Signing in from a terminal works too:

```bash
kimi login
```

Both paths store the same credential, and the Kimi CLI keeps it refreshed from then on. After a
successful sign-in, T3 Code refreshes the provider automatically. Temporary CLI startup delays do
not discard an already healthy connection.

## Models

T3 Code discovers the exact model aliases your Kimi CLI advertises, including managed Kimi Code
aliases and Moonshot model IDs. Pick a model from the model picker like any other provider.

You can switch between Kimi models in an active conversation without starting a new thread. A Kimi
conversation remains bound to its Kimi provider instance; switching it to a different provider still
requires a new thread.

## Plan And Permission Modes

Kimi uses its native session modes for T3 Code's interaction and runtime controls:

| T3 Code control   | Kimi behavior                          |
| ----------------- | -------------------------------------- |
| Plan              | Read-only planning                     |
| Supervised        | Manual approvals                       |
| Auto-accept edits | Automatically approves safe operations |
| Auto              | Automatically approves safe operations |
| Full access       | Automatically approves all operations  |

Plan uses the separate Build/Plan toggle in the composer footer, not the access dropdown. On a
compact composer, open **More composer controls** (`…`) and choose **Mode → Plan**. If the toggle is
hidden, enable **Plan mode (legacy)** under Settings → General → Legacy features. **Auto** maps to Kimi's native auto mode,
while **Full access** maps to Kimi's native YOLO mode.

When Kimi finishes a plan, its exit-plan decision appears as an approval card showing the plan:
approve it to let Kimi leave plan mode and implement in the same turn, or reject it to have Kimi
revise the plan. Approving leaves Kimi's native plan mode for good, so switch the composer back to
**Build** afterwards: while the composer stays on Plan after an approval, follow-up messages run
with the selected runtime access instead of re-entering read-only planning. Approval requests that
Kimi does not handle natively continue to appear in T3 Code.

## Thinking

The model picker shows a **Thinking** option when the selected model advertises one. Choices are
model-specific: K3 models commonly offer Low, High, and Max, while K2.7 Coding models advertise a
narrower set. T3 Code uses only the choices reported by the CLI and refreshes them after a model
switch. If a previously selected value is unavailable on the new model, Kimi's advertised default is
used instead.

## Separate Accounts Or Sandboxes

The Kimi provider settings include a `KIMI_CODE_HOME path`. When set, T3 Code points the Kimi CLI
at that directory for credentials and sessions, so a second provider instance with its own
`KIMI_CODE_HOME path` runs against a separate Kimi account. Signing in from the provider card
writes the credential into that instance's directory.

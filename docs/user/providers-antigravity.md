# Antigravity

T3 Code can run Google Antigravity CLI sessions through the `agy` harness.

## Install And Sign In

Install Antigravity CLI using the
[official installation guide](https://antigravity.google/docs/cli/install/), then launch it once on
the machine running the T3 Code server:

```bash
agy
```

Complete the sign-in flow, then confirm the CLI can load its model catalog:

```bash
agy models
```

T3 Code uses that command to check provider readiness and populate the model picker.

## Configure T3 Code

Open **Settings**, select **Antigravity**, and refresh the provider status. T3 Code finds `agy` on
the server's `PATH` by default. Set **Binary path** when the CLI is installed somewhere the server
cannot discover.

Use **Launch arguments** only for additional Antigravity CLI flags that should apply to every turn.
T3 Code supplies the streaming format, model, reasoning effort, execution mode, continuation, and
permission flags itself.

## Sessions And Models

Antigravity sessions preserve the CLI conversation ID, so later turns and restored T3 Code threads
continue the same Antigravity conversation. Changing models between turns restarts the CLI process
with the same conversation ID and the newly selected model.

The standard T3 Code Plan toggle maps to Antigravity's plan mode. Other turns use accept-edits mode.
Full-access sessions auto-approve Antigravity tool permissions; other T3 Code permission modes run
the CLI sandboxed.

## Troubleshooting

If Antigravity is unavailable in the model picker:

1. Run `agy --version` on the T3 Code server.
2. Run `agy models` and complete sign-in if requested.
3. Check **Settings** → **Antigravity** → **Binary path**.
4. Refresh the provider status.

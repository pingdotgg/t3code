# ZCode

T3 Code attaches to the ZCode daemon (`zcode serve`) as an agent, using your own Z.AI account,
skills, plugins, and MCP configuration. T3 Code starts the daemon when it is not already running
and leaves it running when the session ends, so other ZCode clients on the machine keep working.

## Set Up ZCode

1. Install ZCode on the machine running the T3 Code server. The ZCode app installs the `zcode`
   CLI; make sure it is on that machine's `PATH`, or set its **Binary path** in provider settings.
2. Run `zcode login` once in a terminal on that machine. Login starts an OAuth authorization for
   your Z.AI account, which works on headless servers too: finish it from a browser on any device.
3. Open **Settings → Providers**, enable ZCode, and refresh it.

ZCode runs on the server's machine only. A desktop ZCode app elsewhere does not share its sign-in
with T3 Code; the server's own `zcode login` is what counts.

## Credentials

T3 Code never stores or reads your Z.AI sign-in. The ZCode daemon owns the credential exchange:
it reads the sign-in `zcode login` wrote on the same machine and mints the short-lived account
tokens its turns need. T3 Code attaches to that daemon and never handles the tokens. Signing out
or signing in again from a terminal applies to the next turn.

## Models

After signing in, the model picker lists the GLM models your Z.AI plan offers — no API key or
model configuration needed. Reasoning follows each model's own default level unless you pick one.
New threads start on `default`, which defers to the model your ZCode session resolves on its own.
A model your account cannot use stops the turn with an error instead of running on another model.

## Permission Modes

ZCode gates tool calls by its own permission modes, and T3 Code answers by the permission mode:

- **Supervised** maps to ZCode's guarded mode and sends tool approvals to you. Approvals offer
  only the choices ZCode sends.
- **Auto-accept edits** maps to ZCode's edit mode, which approves file changes without asking.
- **Full access** maps to ZCode's yolo mode and approves tool calls without asking you.

## Steering, Forks and Compaction

- A message you send while ZCode is working joins the running turn.
- Forking a ZCode thread is not available yet, and the fork command is hidden for these threads.
- `/compact` uses ZCode's own compaction.

# Kiro

T3 Code runs the [Kiro CLI](https://kiro.dev/docs/cli/) as an agent, using your own Kiro account,
custom agents, steering, and MCP configuration.

## Set Up Kiro

1. Install the Kiro CLI on the machine running the T3 Code server
   (`curl -fsSL https://cli.kiro.dev/install | bash`).
2. Run `kiro-cli login` once in a terminal. Kiro Pro and higher plans can instead set an API key as
   `KIRO_API_KEY` in the Kiro provider's environment variables.
3. Open **Settings → Providers**, enable Kiro, and refresh it.

If `kiro-cli` is not on the server's `PATH`, set its **Binary path**. The installer usually puts it
in `~/.local/bin`. T3 Code starts Kiro's CLI V3 engine, so a Kiro CLI that cannot run V3 will not
start.

## Models

The model picker lists the models your Kiro account can use once Kiro is signed in. **Kiro
default** lets Kiro choose (its `auto` model). A model your account cannot use stops the turn with
an error instead of running on another model.

Models with adjustable reasoning effort, such as recent Claude Opus and Sonnet models and GPT-5.6,
show a **Reasoning** setting with only the levels Kiro offers for that model. **Kiro default** and
models without effort control run at Kiro's own setting.

## Permission Modes

Kiro asks before tool calls such as writes and commands, and T3 Code answers by the permission mode:

- **Supervised** sends those requests to you. Kiro's Autopilot is off, so Kiro also asks you to
  review the turn's file changes before it finishes.
- **Full access** approves them without asking you. Autopilot stays on, so there is no review step.

Kiro offers no **Auto** or **Auto-accept edits**. Approvals offer only the choices Kiro sends. Kiro's
"always allow" saves a rule for the whole workspace, so T3 Code does not offer it as a
session-wide choice.

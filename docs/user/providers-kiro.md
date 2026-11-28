# Kiro

Run the [Kiro CLI](https://kiro.dev/docs/cli/) (V3 engine) in T3 Code with your Kiro account, custom agents, steering, hooks, and MCP config.

## Set up Kiro

1. Install the Kiro CLI on the server machine:
   - macOS / Linux: `curl -fsSL https://cli.kiro.dev/install | bash`
   - Windows 11 (PowerShell): `irm 'https://cli.kiro.dev/install.ps1' | iex`
2. Run `kiro-cli login` (or set `KIRO_API_KEY` in the instance's environment variables on Kiro Pro+).
3. Open **Settings → Providers**, enable **Kiro**, and refresh. Set **Binary path** if `kiro-cli` (typically `~/.local/bin`) isn't on `PATH`.

## Models and custom agents

- **Models**: Listed from your signed-in Kiro account (defaults to `auto` unless your account/org sets another). Supported models expose a **Reasoning** effort selector.
- **Custom agents**: Pick built-in agents (e.g. Spec, Plan) or user agents from `~/.kiro/agents` in the **Agent** selector next to the model (refresh provider after adding/removing agents). Project `.kiro/agents` are not listed yet. The thread's model takes precedence over an agent's `model` field.

## Permission modes

- **Supervised**: Prompts for writes and commands, disables Kiro Autopilot, and asks you to review file changes at the end of a turn.
- **Full access**: Approves tool calls automatically with Autopilot on.

**Auto** and **Auto-accept edits** are not supported. Kiro's **Always allow** (which persists workspace-wide) is only shown when Kiro offers no one-time option.

## Steering, forks, and compaction

- **Steering**: Text follow-ups join the running turn after the current step; messages with images restart the turn.
- **Forking**: Uses Kiro's native conversation copy up to the selected message.
- **Compaction**: Supports `/compact` as well as Kiro's automatic compaction.

# fx

Run [fx](https://fx.sh) in T3 Code using the fx login and backends configured on your server machine. Requires **fx 0.0.13+** (macOS 15+ for releases after 0.0.13).

## Set up and update

1. Install fx on the server machine:
   ```bash
   curl -fsSL https://fx.sh/setup.sh | bash
   ```
2. Run `fx login` on that machine.
3. Enable **fx** in **Settings → Providers** and refresh (set **Binary path** if `fx` isn't on `PATH`).

All fx instances on a machine share that machine's fx login.

- **Updates**: Click **Update now** in **Settings → Providers** for standalone (`fx upgrade`) or Homebrew (`fx-agent`) installs. Update mise, MacPorts, Nix, or dev-channel installs manually.

## Backends, models, skills, and MCP

- **Backends**: fx supports Vercel AI Gateway, Codex, Grok, and custom OpenAI-compatible endpoints. Each backend appears under its own heading in the model picker; switching backends applies per thread without changing your terminal's `fx provider` default. Signed-out backends show their login command (e.g. `fx login grok`).
- **Default model & effort**: **Default** uses fx's configured default for that project folder. **Effort** defaults to Medium.
- **Skills & MCP**: Type `$` to invoke skills discovered by fx (case-insensitive deduplication; type exact case if two skills differ only in casing). MCP servers load from `~/.fx/mcp.json`.

## Permission modes and steering

| Mode            | Behavior                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| **Supervised**  | Asks before edits and commands; reads proceed without asking.                                |
| **Auto**        | Handles routine actions automatically; forwards remaining prompts to you.                    |
| **Full access** | Runs all actions without asking (requires **fx 0.0.14+**; refresh provider after upgrading). |

- **Auto-accept edits** is not supported (falls back to Supervised). Changing modes reloads the fx session.
- On fx 0.0.14+, setting a mode in T3 Code also updates fx's saved default permission mode.
- Steering into a running turn stops that turn and answers the new message in the same session.

## Sub-agents and limitations

- **Sub-agents**: Shown as child threads with their task, each tool they run, what they say between tools, and their full reply (cut off with a note past 64 KiB). Steps of a sub-agent's own sub-agents aren't shown. When fx doesn't confirm hook support, a child thread shows only its task and a reply shortened to a couple of lines. fx does not forward sub-agent permission prompts—use **Auto** or **Full access** so sub-agents don't stall waiting for approval.
- **Not supported**: **Auto-accept edits**, and T3 Code text generation (titles, commit messages, PR descriptions, branch names)—pick another provider for those.

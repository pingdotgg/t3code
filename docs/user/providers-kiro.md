# Kiro

T3 Code runs the Kiro CLI's agent on your selected environment through its Agent Client Protocol mode. Kiro keeps its own login, agents, and credit plan; T3 Code adds threads, approvals, and history on top.

## Set up Kiro

1. Install the [Kiro CLI](https://kiro.dev/cli) on the machine running the T3 Code server and run `kiro-cli setup` if the installer asks for it. A Homebrew install is not complete until setup has run; T3 Code reports a missing chat component until then.
2. Run `kiro-cli login` in a terminal and finish the sign-in.
3. Open **Settings > Providers**, choose the environment, enable Kiro, and refresh the provider.

If `kiro-cli` is not on the server's `PATH`, set **Binary path** to the executable. Kiro is supported from kiro-cli 2.23.

## Models

The model list comes from Kiro. **Auto** lets Kiro choose a model per task; the other entries are the models your plan offers. Changing the model applies to the next message in the thread.

Sessions run Kiro's default agent, with the prompt, tools, steering files, and MCP servers it has in the Kiro terminal.

## Permissions

Tool approvals follow [Permission modes](./permission-modes.md). Tools the Kiro agent already trusts on its own, such as reads and searches, never ask.

## What is not available yet

T3 Code's Plan mode is not offered for Kiro; ask for a plan in the message instead. Kiro's questions arrive as ordinary text, so reply to them as you would in a chat. Context usage, credit usage, and Kiro's own delegated agents are not shown, and Kiro does not generate thread titles, commit messages, or pull request text; choose another provider for those in the text generation settings.

## Troubleshooting

- `Not logged in`: run `kiro-cli login` on the environment, then refresh the provider.
- `chat component is missing`: run `kiro-cli setup`, then refresh the provider.
- If the model list is incomplete, T3 Code keeps **Auto** available; run `kiro-cli chat --list-models` in a terminal to check the CLI can reach Kiro.

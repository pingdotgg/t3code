# T3 Code for VS Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, and OpenCode, more coming soon), packaged as a VS Code extension.

The extension requires the T3 Code desktop app to be running on the same machine. It connects to the desktop-owned local backend, opens the T3 Code UI inside VS Code, and advertises VS Code-only MCP tools that desktop-launched agent sessions can discover for the matching workspace.

If the desktop app is not running, the VS Code panel shows a start-desktop notice instead of the T3 Code UI. Start the desktop app manually, then click **Reconnect** in that panel or run `T3 Code: Reconnect to Desktop Backend`.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

Install the latest VS Code extension build from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then use VS Code's "Install from VSIX..." command.

## VS Code UI

- `t3code.sidebarView`: the T3 Code Secondary Side Bar panel. Use it to open the workspace-scoped T3 Code chat UI inside VS Code.
- `t3code.conversationEditor`: the T3 Code thread editor used to open T3 Code threads in editor tabs.

The extension hides T3 Code controls that duplicate VS Code-native surfaces by default, including the open/reveal picker, checkout indicator, branch selector, and embedded terminal drawer. These can be restored with the settings below.

## VS Code MCP Tools

When enabled, the extension starts a local VS Code MCP bridge for agent sessions launched from the desktop backend. Codex, Claude Code, OpenCode, and Cursor sessions can use these tools to ask VS Code for editor-aware information and to invoke registered VS Code commands:

- `vscodeDiagnostics`: reads diagnostics currently known to VS Code.
- `vscodeReferences`: finds symbol references at a file position.
- `vscodeWorkspaceSymbols`: searches workspace symbols.
- `vscodeRunCommand`: runs an allowed registered VS Code command and returns its result. Calls can include `activateExtension` to activate an installed extension id before the command registration check, but only when that extension id is listed in `t3code.mcp.allowedActivateExtensions`. Allowed commands default to `t3code.*`, `vscode.open`, `vscode.diff`, and `revealLine`, and can be customized with `t3code.mcp.allowedRunCommands`.

The MCP bridge is enabled by default and can be disabled with `t3code.mcp.enabled`. MCP tool calls default to a 120-second timeout, configurable with `t3code.mcp.toolTimeoutSec` with a minimum of 5 seconds. This timeout is passed through where the provider supports an equivalent setting. Each VS Code window gets its own MCP server identity and local socket, so desktop provider sessions can route tools back to the matching VS Code window.

## Commands

- `T3 Code: Open` (`t3code.open`): focuses the T3 Code Secondary Side Bar panel.
- `T3 Code: New Thread` (`t3code.newThread`): opens a new T3 Code thread in an editor.
- `T3 Code: Reconnect to Desktop Backend` (`t3code.restartBackend`): drops the current VS Code bearer session and reconnects to the desktop-owned local backend. This does not launch the desktop app; start desktop manually first if it is not already running.
- `T3 Code: Clean Virtual Workspace Cache` (`t3code.cleanVirtualWorkspaceCache`): removes inactive T3-owned virtual workspace checkouts.

## Settings

- `t3code.home`: optional T3 home directory. Defaults to `~/.t3`, matching the desktop app.
- `t3code.mcp.enabled`: enable the VS Code MCP bridge for desktop-launched agent sessions. Defaults to `true`.
- `t3code.mcp.toolTimeoutSec`: maximum time, in seconds, provider sessions should wait for a VS Code MCP tool call. Defaults to `120`; values below `5` fall back to the default.
- `t3code.mcp.allowedRunCommands`: VS Code command ids that `vscodeRunCommand` may execute. Defaults to `["t3code.*", "vscode.open", "vscode.diff", "revealLine"]`; entries ending in `*` are treated as non-empty command-prefix rules.
- `t3code.mcp.allowedActivateExtensions`: installed VS Code extension ids that `vscodeRunCommand` may activate before executing an allowed command. Defaults to `[]`.
- `t3code.ui.showOpenInPicker`: show the T3 Code open/reveal picker inside VS Code webviews. Defaults to `false`.
- `t3code.ui.showCheckoutModeIndicator`: show the T3 Code checkout mode indicator inside VS Code webviews. Defaults to `false`.
- `t3code.ui.showBranchSelector`: show the T3 Code branch/ref selector inside VS Code webviews. Defaults to `false`.
- `t3code.ui.enableTerminal`: enable the T3 Code terminal drawer, terminal actions, and terminal keybindings inside VS Code webviews. Defaults to `false`.
- `t3code.ui.threadConversationMaxWidth`: optional maximum width, in pixels, for the thread conversation timeline and prompt input inside VS Code webviews. Leave empty for no maximum width.
- `t3code.ui.restoreDefaultTheme`: use T3 Code's default app theme instead of matching the active VS Code theme and fonts. Defaults to `false`.

## Some notes

> [!NOTE]
> T3 Code is very early. Expect bugs.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

# Run the visual fork on Windows with WSL

The launcher opens the installed Windows Electron app with the web interface from this checkout. Its native desktop bridge starts the bundled backend in WSL. This is a local development setup, not an independently packaged fork: it requires the installed T3 Code desktop runtime and the WSL checkout. Desktop/backend features come from the installed runtime; web changes come from this checkout. Keep those versions compatible.

## Requirements

- T3 Code desktop installed on Windows.
- A WSL distribution with this checkout, its dependencies installed with `vp i`, and Vite+ on PATH.
- Agent CLIs installed and authenticated in that distribution.
- Free ports 5743 for the frontend and 13843 for the backend. Override both when needed.

From Windows PowerShell, replace the distribution and repository path as appropriate:

```powershell
$launcher = '\\wsl.localhost\Ubuntu\home\YOU\work\t3code\scripts\windows\start-fork.ps1'
& $launcher -Repository /home/YOU/work/t3code -Distro Ubuntu -ValidateOnly
& $launcher -Repository /home/YOU/work/t3code -Distro Ubuntu -InstallShortcut
```

Open **T3 Parade** on the Windows desktop. The launcher starts the frontend, waits for it, then opens the native window. Closing that window stops the frontend it started. A second invocation while it runs returns without creating another stack. The WSL server lifecycle is managed by the desktop runtime.

For an installation outside the default location, pass `-DesktopExecutable 'C:\path\T3 Code (Beta).exe'` when creating the shortcut. `-WebPort` and `-ServerPort` select different ports.

## State and troubleshooting

Windows desktop state, the Chromium profile, and launcher logs live under `%LOCALAPPDATA%\T3-Parade`. The WSL backend uses T3's development state at `~/.t3/dev`; it does not open production `~/.t3/userdata`. Other T3 desktop development sessions use that same Linux development directory, so do not run them concurrently with this launcher. The existing production app is not replaced, and automatic updates are disabled for the launcher process.

On the first launch, onboarding can discover agent history. Uncheck project import to start with an empty environment. Authentication stays with the existing WSL CLIs.

If startup fails, inspect `%LOCALAPPDATA%\T3-Parade\logs\launcher-error.log`, `web.stdout.log`, and `web.stderr.log`. Check that the configured WSL distribution exists, the checkout has dependencies, and the ports are free. Development can take longer on its first load while Vite prepares dependencies. The launcher hides the development tools window opened automatically by the installed development shell.

A standalone Windows installer remains a separate build. It requires the Windows build prerequisites in [Development](development.md#windows-installer-prerequisites) and a matching Linux CLI archive for the bundled WSL runtime. It should receive its own application identity and data directories before distribution.

## Visual interface

The fork uses an Alan-inspired three-column layout: compact thread navigation, a conversation with project session tabs, and collapsible details cards. The plus beside the tabs opens a draft in the current project. Narrow windows expose details through the panel button.

**Needs you** lists pending approvals, user questions, subagent requests, and guest messages. Selecting a session opens its conversation. Usage limits and context appear when the selected provider reports them. The context card shows the latest reported token breakdown, without assuming every provider reports cumulative session totals. Checks appear for a linked pull request with reported checks. MCPs appear for explicitly named MCP tool calls recorded in that conversation.

Right-click a details card to choose which items to show. Explicit visibility choices are preserved. The Windows launcher serves the same interface; reopen **T3 Parade** after updating the checkout if its window has not refreshed.

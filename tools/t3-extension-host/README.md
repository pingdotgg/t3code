# T3 Extension Host

Runs the VS Code extensions you already have installed against what happens in T3 Code. Discord Presence and WakaTime were the starting point; any extension in `~/.vscode/extensions` can now run.

T3 Code has no extension system, so this project gives extensions their own stand-in for the `vscode` API and drives it from T3 Code's local state:

| In T3 Code | What the extensions see |
| --- | --- |
| An agent edits a file | That file opens in the active editor and its text changes; file watchers fire |
| The thread you're viewing (or the one an agent is working in) | The open workspace folder, named after the T3 project |
| An agent run is in progress | An AI chat panel is focused, so WakaTime logs **AI coding** |
| The T3 Code window has focus | The editor window has focus |
| The workspace's git repo | VS Code's built-in git extension (branch, remotes) |

Extensions are loaded straight from `~/.vscode/extensions`, unmodified, so updating them in VS Code updates them here too. Your VS Code `settings.json` applies, and extensions share VS Code's global storage, so caches and downloaded tools are reused.

## What works

- **Loading:** CommonJS and ES module extensions, `extensionDependencies`, and the manifests of VS Code's built-in extensions (languages, setting defaults, `getExtension`).
- **Activation events:** `*`, `onStartupFinished`, `onLanguage`, `workspaceContains`, `onCommand`, plus the implicit events VS Code derives from contributed commands and languages.
- **API:** documents, editors, selections, workspace folders, settings (including nested sections and type defaults), commands, status bar, output channels, diagnostics, `workspace.fs`, `findFiles`, file watchers, secrets, global/workspace state, and terminals.
- **Terminals:** process-backed (an extension that starts a language server through a terminal, like PowerShell, gets a real process) and extension pseudo-terminals.
- **Everything else** (webviews, tree views, language providers, debuggers, tests, chat, and so on) is accepted and ignored instead of crashing the extension. With `T3_EXTENSION_HOST_LOG_LEVEL=debug`, the log names each such API and the extension that used it.

### Check your extensions

```powershell
npm run scan                    # test-activate every installed extension, one isolated process each
npm run scan -- vue.volar       # just one
npm run scan -- --all           # include excluded extensions too
```

The report shows whether each extension activated, when it would normally start, and which APIs it used that T3 Code can't show. It's also saved as `%APPDATA%\t3-extension-host\scan.json`. Scanning runs in a throwaway settings sandbox and kills every process an extension started.

### What it can't do

T3 Code has no text editor, so anything an extension *shows inside the editor* has nowhere to appear: completions, hovers, formatting, inline errors, themes, icon themes, snippets, webview panels, sidebars, debugging. Those extensions load and run, but you won't see their output. The ones that pay off are background extensions that react to editing: presence, time tracking, git tooling, file watchers, and scripts that send data elsewhere.

Some extensions refuse to run outside Microsoft's VS Code by license (for example C# Dev Kit); the host doesn't work around that.

## Requirements

- Node.js 22.15 or newer (uses `node:sqlite` and module hooks)
- T3 Code desktop
- VS Code with your extensions installed (VS Code itself doesn't need to be running)
- Discord desktop running, for presence

## Usage

```powershell
npm run check              # diagnose: T3 Code, VS Code, extensions, Discord
npm run scan               # compatibility report for your extensions
npm start                  # run in the foreground
npm run install-startup    # start hidden at Windows login (and start now)
npm run uninstall-startup  # remove the login item and stop it
```

The supervisor waits for T3 Code to start, then launches the extensions in a child process. It shuts them down when T3 Code closes, which clears your Discord status and stops language servers. Only one instance runs at a time.

Logs go to `%APPDATA%\t3-extension-host\logs\host.log`, including every WakaTime heartbeat and each extension's output channel.

## Configuration

Optional files in `%APPDATA%\t3-extension-host\`:

- `settings.json`: extension settings that apply only under T3 Code, using VS Code keys such as `"discord.detailsEditing": "Agent editing {file_name}"`. These override your VS Code settings. Settings that extensions change at runtime are saved here too, never in VS Code's own settings.
- `config.json`: host options (see `config.example.json`):

| Option | Default | Meaning |
| --- | --- | --- |
| `extensions` | `"*"` | `"*"` for every installed extension, or a list of IDs. A list can also name built-in ones such as `vscode.emmet` |
| `exclude` | AI agent extensions | IDs skipped when `extensions` is `"*"`. The defaults (Claude Code, Codex, Copilot, Cline and similar) would start a second agent or IDE bridge next to T3 Code. Setting this replaces the whole list |
| `respectVSCodeDisabled` | `true` | Skip extensions you disabled in VS Code |
| `shareVSCodeStorage` | `true` | Use VS Code's global storage folders for extensions |
| `activationTimeoutSeconds` | `15` | How long startup and commands wait for a slow extension (it keeps starting in the background) |
| `extensionsDir` | `~/.vscode/extensions` | Where installed extensions live |
| `vscodeInstallDir` | `%LOCALAPPDATA%\Programs\Microsoft VS Code` | Where VS Code's built-in extensions are found |
| `vscodeSettings` | `%APPDATA%\Code\User\settings.json` | VS Code user settings to read |
| `appName` | `"T3 Code"` | Reported as `vscode.env.appName` (Discord's `{app_name}`, WakaTime's editor name `t3code`) |
| `pollMs` | `1500` | How often T3 Code's state is read |
| `agentPulseSeconds` | `30` | While an agent runs, how often it counts as activity |
| `editorLingerSeconds` | `300` | How long the last edited file stays "open" after the agent stops |
| `ignoreOutsideWorkspace` | `true` | Ignore agent edits outside the thread's project or worktree |
| `ignoreProjects` | `[]` | T3 project titles to ignore completely, e.g. `["No project"]` |
| `reconnectDiscordSeconds` | `30` | Retry Discord automatically if it wasn't running when T3 started (`0` to disable) |
| `discordClientId` | `null` | Application ID of your own Discord application. Discord shows that application's name (for example "T3 Code") instead of "Visual Studio Code". Language images keep working |
| `discordLargeImages` | Moon, sparkle, speech bubble, `"language"` | Large image per mode (see below). `"language"` uses the file-type icon. Values are image links, or VS Code Discord Presence image names such as `"ts"` |
| `discordSmallImage` | Round T3 Code logo on the same background color as that mode's large image (black while editing) | Small image: one link for every mode, or one per mode. `""` keeps the extension's VS Code icon |
| `discordSmallText` | `"T3 Code · {model}"` (`"T3 Code"` when idle) | Hover text of the small image: one text, or one per mode |
| `discordLanguageImages` | `{}` | Your own file-type images, keyed by file extension (`".ts"`) or language ID (`"typescript"`). Files without an entry keep Discord Presence's icon |
| `discordPresenceImages` | `discord-assets/presence` on the fork | Where the 205 Discord Presence images live, recolored onto black (file-type icons such as `ts`, `python`, `vue`). `""` uses Discord Presence's original colored versions |
| `discordShowButtons` | `false` | Discord Presence adds a "View Repository" button with your git remote. The host removes it and any other links unless this is `true` |
| `discordSwapImages` | `false` | Swap the large and small images and their hover texts, like Discord Presence's `swapBigAndSmallImage` |
| `discordStatus` | see `config.example.json` | `details`, `state` and `largeText` per mode. Placeholders: `{project}`, `{thread}`, `{file}`, `{language}`, `{model}`, `{agent}`. A mode set to `null` keeps the extension's own texts. Thread titles are hidden for projects in `ignoreProjects` |

The Discord modes are `idle` (no agent running), `working` (an agent is running), `waiting` (the agent is waiting for your answer or approval) and `editing` (the agent just edited a file). Partial settings merge with the defaults, so `{ "discordLargeImages": { "idle": "https://…" } }` changes only the idle image. The default large images show only the state (the T3 logo is already the small image). They are in `assets/` and are served from the `discord-assets` branch of the fork.
| `logLevel` | `"info"` | `debug`, `info`, `warn` or `error` |

## Limitations

- Only agent activity is tracked. Time spent reading threads or typing prompts produces no editor events.
- Extensions report `vscode.version` as your installed VS Code version (or the newest one any extension requires), because many refuse older versions.
- Discord Presence has VS Code's Discord application ID built in, so your profile says **Visual Studio Code** until you set `discordClientId`. Discord takes the name from the application, so it can't be changed any other way.
- Extension state saved with `globalState` is kept separately from VS Code's, so some extensions treat their first run here as a fresh install.
- Secrets that extensions store are kept in memory only and are gone after a restart.
- Commands from the command palette, quick picks and input boxes can't be shown; extensions see them as cancelled.
- Plain terminals don't execute what extensions type into them, since nobody would see it run.
- All extensions share one process. One that calls `process.exit` takes the others down; the supervisor restarts them.
- T3 Code's database is read-only here. If a T3 update changes its schema, the log reports failed polls instead of tracking.
- Window focus detection is Windows-only. On macOS and Linux the window is always treated as focused. On first run the host compiles a ~5 KB focus helper into `%APPDATA%\t3-extension-host\bin` with the C# compiler that ships with Windows; if that isn't possible it falls back to a PowerShell loop, which uses more memory.

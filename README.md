# T3 Code

T3 Code is a modern desktop GUI for coding agents. Multi-provider support for OpenAI Codex, Anthropic Claude, and Google Gemini — all in one app.

## Install

### One-line install (Windows)

```powershell
irm hlsitechio.github.io/t3code/install.ps1 | iex
```

An interactive wizard walks you through each step — choose your install folder, pick dependencies, and install provider CLIs. Run the same command to update.

### Manual install

Download the latest MSI/DMG/AppImage from the [Releases page](https://github.com/hlsitechio/t3code/releases).

### CLI only

```bash
npx t3
```

## Features

### Integrated Terminal
- GPU-accelerated rendering via WebGL (xterm.js + `@xterm/addon-webgl`)
- Optimized I/O with debounced input/output buffering
- Per-thread terminal sessions with persistent history
- Fallback to DOM renderer when WebGL is unavailable

### Browser Integration (Desktop)
- Built-in browser view powered by Chrome DevTools Protocol (CDP)
- Navigate, observe, interact, and extract content from web pages
- Element observation with attribute, label, and text extraction
- Screenshot capture and action execution (click, type, scroll)
- Side-by-side or stacked layout with the chat view

### Canvas (React Code Preview)
- Live React component preview with Babel JSX transform
- Thread-level canvas state with file management (`App.jsx`, `styles.css`, `canvas.md`)
- Device preview modes: Desktop, Tablet, Mobile
- Agent-driven streaming updates to canvas files

### Lab Workspace
- Experimental workspace surfaces for new layouts and interactions
- Browser + chat side-by-side (responsive stacking on smaller screens)
- Thread-specific lab instances

### Document Upload
- Attach documents to chat threads (`.txt`, `.md`, `.pdf`, `.docx`)
- Up to 16 documents per thread, 8 MB per file
- Automatic text extraction from PDFs and Word documents
- Document context injected into agent prompts (32K char limit)

### Code Formatting
- Automatic Prettier formatting for code blocks in chat
- Supports JavaScript, TypeScript, HTML, CSS, Markdown, YAML, and more
- 7 Prettier plugins with graceful fallback

### IDE Integrations
- Open projects directly in your editor of choice:
  - **Cursor** — `cursor`
  - **VS Code** — `code`
  - **Windsurf** — `windsurf`
  - **OpenCode** — `opencode`
  - **Zed** — `zed`
  - **File Manager** — system default

### Multi-Provider Authentication
- **OAuth browser login** for all providers — sign in with one click:
  - OpenAI (ChatGPT)
  - Anthropic (Claude)
  - Google (Gemini)
  - GitHub
- API key fallback for manual configuration
- Provider health checks with status indicators

### GitHub Integration
- Browser-based OAuth authentication — no PAT required
- GitHub CLI (`gh`) token support
- Configurable GitHub actions automation, PR auto-merge, and security workflows

### MCP Server Infrastructure
- App Operator MCP server for project context, canvas mutations, and action execution
- Lab Browser MCP server for browser observation, actions, and screenshot capture
- Standard Model Context Protocol for agent tool integration

### Project Management
- Multi-project sidebar with favorites and thread previews
- Thread status tracking (Working, Completed, Pending Approval)
- Project onboarding with branch, worktree, and environment mode options
- Folder picker integration for adding new projects

### Settings
- 8 configurable sections: Appearance, Codex, Canvas, Models, GitHub, Responses, Keybindings, Safety
- Searchable settings with section navigation
- Keyboard shortcuts editor
- Model and reasoning effort selection
- Service tier configuration (Auto/Fast/Flex)

### Interactive Install Wizard
- Copilot-style setup that walks you through each step
- Choose your install folder (default, current directory, or custom path)
- Scans for missing tools and asks before installing each one
- Package manager choice: winget (recommended) or Chocolatey
- Installs provider CLIs: Codex, Claude Code, Gemini CLI
- Source code clone/pull with automatic `bun install`
- Same command to install and update — detects existing installation

### Provider Health
- Startup-time CLI health checks (version + auth probes)
- Multi-provider status indicators: Ready, Limited, Attention

## Architecture

T3 Code is a monorepo built with:

- **Desktop** — Electron 40.6 with CDP browser integration
- **Server** — Node.js with Effect-ts service composition
- **Web** — React + Vite 8 + TanStack Router
- **Contracts** — Shared schemas (Effect Schema) for type-safe RPC
- **Shared** — Common utilities and models
- **Package Manager** — Bun 1.3.9

## Update

Run the same install command to update everything:

```powershell
irm hlsitechio.github.io/t3code/install.ps1 | iex
```

The app also checks for updates automatically on launch via GitHub Releases.

## Contributing

We are very early in this project. Expect bugs.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

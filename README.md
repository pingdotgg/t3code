# T3 Code

T3 Code is a modern web GUI for coding agents. Currently Codex-first, with Claude Code support coming soon.

## How to use

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for T3 Code to work.

```bash
npx t3
```

You can also install the desktop app for the full experience.

Install the [desktop app from the Releases page](https://github.com/pingdotgg/t3code/releases)

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

### GitHub Integration
- OAuth Device Flow authentication (RFC 8628) — no PAT required
- GitHub CLI (`gh`) token support
- Personal Access Token manual entry
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

### Provider Health
- Startup-time Codex CLI health checks (version + auth probes)
- Minimum version enforcement (>=0.37.0)
- Status indicators: Ready, Limited, Attention

## Architecture

T3 Code is a monorepo built with:

- **Desktop** — Electron 40.6 with CDP browser integration
- **Server** — Node.js with Effect-ts service composition
- **Web** — React + Vite 8 + TanStack Router
- **Contracts** — Shared schemas (Effect Schema) for type-safe RPC
- **Shared** — Common utilities and models
- **Package Manager** — Bun 1.3.9

## Some notes

We are very early in this project. Expect bugs.

We are not accepting contributions yet.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

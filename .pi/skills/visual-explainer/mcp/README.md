# Visual Explainer MCP server

This directory contains the local Model Context Protocol server for visual-explainer.

## Scope

The server is stdio-only. It is meant for MCP hosts that launch a local child process.
It does not start an HTTP listener, handle credentials, call an LLM, or store output outside the local machine.

Rendered files are written only inside the configured output directory. The default is `~/.agent/diagrams/`. Set `VISUAL_EXPLAINER_OUTPUT_DIR` to move that jail to another directory on the same machine; unset keeps the default path byte-identical. A configured jail must resolve to itself, so symlinked jail paths are rejected. Render targets reject existing symlinks and are written through a temporary file rename. Choose a directory only your user can write; avoid world-writable or group-writable shared folders so another local user cannot replace render targets between validation and write. Filenames must be basenames. Paths, traversal, control characters, and symlink targets are rejected.

## Run from a package install

```json
{
  "mcpServers": {
    "visual-explainer": {
      "command": "visual-explainer-mcp"
    }
  }
}
```

## Run from a checkout

Install dependencies first:

```bash
npm install --no-package-lock
```

Then point the host at the server entry:

```json
{
  "mcpServers": {
    "visual-explainer": {
      "command": "node",
      "args": ["/absolute/path/to/visual-explainer/plugins/visual-explainer/mcp/server.mjs"]
    }
  }
}
```

## Exposed tools

- `visual_explainer_prepare`: returns a recommended visual explanation flow. It does not write files.
- `visual_explainer_render_html`: validates a complete HTML document and writes it to the configured output directory (default `~/.agent/diagrams/`).
- `visual_explainer_render_quick`: validates a quick-mode JSON spec and writes rendered HTML to the configured output directory (default `~/.agent/diagrams/`).

Render tools default to `open: false`. Set `open: true` only when you want the server to request a browser or Glimpse window.

## Exposed prompts

The server exposes the bundled command templates as MCP prompts:

- `generate-web-diagram`
- `generate-visual-plan`
- `generate-slides`
- `diff-review`
- `plan-review`
- `project-recap`
- `fact-check`

Pass `request` to fill the template's `$@` argument.

## Exposed resources

The server exposes read-only resources for the canonical skill, command templates, and quick-mode contract:

- `visual-explainer://skill/SKILL.md`
- `visual-explainer://commands/*.md`
- `visual-explainer://quick/README.md`
- `visual-explainer://quick/schema.json`

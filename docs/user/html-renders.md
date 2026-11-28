# Visual replies and MCP apps

Agents can render self-contained HTML visuals (charts, diagrams, tables, image collages, mockups) and interactive MCP Apps inline in a thread on web, desktop, and mobile.

## Visual replies (HTML renders)

Ask an agent for a visual (e.g. "show this as a chart" or "make a collage of these screenshots"). The rendered page appears above the agent's reply, adapts to your light/dark theme, and runs sandboxed away from your T3 Code session.

- **Local images**: Embedded when published so they stay intact even if the original files move or are deleted.
- **Preview browser**: Before publishing, agents verify their visual with T3 Code's bundled headless Chromium (~120 MB one-time download, shared with [remote browser tabs](./remote-access.md#browser-host-setup)).
- **Network restrictions**: Previews can load public CDN assets but block private/local-network IPs. If Clash/Mihomo fake-IP DNS causes CDN loads to fail, inline the resource, add the host to `fake-ip-filter`, or switch proxy DNS to `redir-host`.

## MCP apps

MCP servers supporting the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard render interactive UIs directly below their tool calls (supported on Codex and Claude Code 2.1.301+ on up-to-date T3 servers).

- **Safety**: Select **Review tool request** above the app to approve or decline a server tool call that can make changes. **Allow in this conversation** also approves future calls from the same preview to that tool until you close or reload T3 Code. Use **Revoke tool access** above the preview to ask for approval again. T3 Code also asks before the app posts messages, opens links (mobile), or saves files. Navigating away from its own page stops the app.
- **Session requirement**: Apps remain viewable after a turn ends, but interacting with them requires the thread's agent session to be running.
- **Full screen**: Expand an app full screen and press `Esc` (or the corner button) to return to the thread.

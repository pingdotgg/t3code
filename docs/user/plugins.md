# Plugins

In the web and desktop clients, open **Settings → Plugins** to browse Codex, Claude Code, and Cursor
plugins from the current environment. You can also use the Plugins button at the bottom of the
sidebar or open the command palette and choose **Browse plugins**.

The marketplace reads installed and available packages from configured Codex and Claude Code
marketplaces. It also reads Cursor's public marketplace and local Cursor plugin cache. When this
environment is signed in to ChatGPT through Codex, search also queries ChatGPT's public plugin
index, so listings that only appear there — such as TickTick — show up in results. Filter by MCP
server, skill, app, harness, or category, and select a plugin to inspect its contents. Plugin artwork and metadata come from the package or its published marketplace listing.
Use the **Installed** view to see every installed package without repeating those packages throughout
the browse categories. Equivalent category names from different marketplaces are combined into one
category.

Marketplace changes use the configured binary, home directory, and environment of that harness's
provider instance. If more than one enabled instance of the same harness is configured, manage its
plugins with the provider directly until per-instance marketplace selection is available.

Same-named packages from different harnesses appear as one listing. The detail page still installs
and removes each harness copy separately and shows that package's published MCP servers and
components.

Package contents are shown in the terms used by each harness. Codex bundles skills, MCP connections,
apps, and optional hooks. Claude Code packages can also include namespaced commands, subagents,
language servers, and monitors. Cursor packages can include editor rules, commands, subagents,
hooks, skills, and MCP servers. T3 Code reads Cursor's published inventory directly and inspects the
source of remote Claude packages when you open their details.

Installation switches update the real Codex or Claude Code configuration on that environment.
When a Codex message explicitly mentions an installed plugin with `$plugin-name`, T3 Code forwards
that plugin's enabled skills with the turn, including in an existing thread. Start a new chat after
changing MCP servers or apps so the harness can refresh those longer-lived connections.

Remote HTTP MCP servers that require OAuth have an **MCP authentication** section after
installation. Select **Connect** to open the provider's authorization page. Codex usually
completes the loopback flow in the browser; if it opens its own sign-in window instead, finish
there and return to T3 Code. Claude Code may ask you to paste the full callback URL back into the
plugin page when the environment is remote. Connection status and **Disconnect** use each
harness's native credential store, so T3 Code never keeps a separate copy of the access or refresh
token. Cursor connections continue in Cursor's own settings. Local standard-input MCP servers do
not use the HTTP OAuth flow.

On macOS, the Computer Use detail page includes **Permission setup**. Open the signed Computer Use
setup app there to grant Accessibility and Screen Recording, or jump directly to the Accessibility
and Automation pages in System Settings. T3 Code declares its Automation purpose to macOS so the
system can show consent prompts for the applications you choose. When browsing a remote
environment, these actions open on the Mac hosting that environment.

Cursor does not currently provide a non-interactive plugin install command, so Cursor rows open the
official Cursor Marketplace for installation or removal. ChatGPT Public listings open the ChatGPT
plugin directory the same way. Secret environment variable values are never displayed.

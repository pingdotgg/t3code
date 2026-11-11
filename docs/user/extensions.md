# Extensions

Extensions add commands, agent tools, settings pages, and custom panels to T3 Code. They run on the server you connect to, so the same extension can serve desktop, web, and mobile clients through T3 Connect.

Open **Settings > Extensions**, choose the owning environment, and select **Add extension**. Choose **Local folder** to browse folders on that server or enter a path, or choose **npm package** and enter the package name. Extensions execute trusted code with full access to that machine. Install code you trust. T3 manages the Node/npm runtime for all extensions; the first activation downloads it.

Installed extensions can add their own pages to the main Settings list. Their commands appear in the command palette, and declared actions appear in the thread's extension menu. Panels can follow the client's light/dark mode and theme. Settings and extension data belong to the server, while the theme follows the client viewing the panel.

Use Extensions settings to update, disable, enable, reload, or uninstall an extension. Reload after changing local source. If activation fails, its diagnostic appears there. A failed npm update restores the previous working version. Disabling stops the extension; uninstalling preserves its data and any local source folder.

T3 installs the extension-development skill and its full API guide automatically when the server starts, and refreshes them on later starts. To create or modify an extension, ask your agent to use `t3-extension-development`; it can load the installed skill and guide with `extensions_development`. No separate skill installation is needed. See the [developer guide](../extensions.md) for a complete TypeScript starter, custom panel, Settings pages, themes, packaging, and troubleshooting.

# Plugins

Open **Settings > Plugins** and choose an environment. Local extensions belong to that
environment, and its connected clients use the same enabled state.

Search the reviewed catalog and choose **Install** to copy a reviewed package into the
environment. Installation verifies the package's pinned SHA-256 fingerprint and leaves it
disabled. Enable the installed extension when you want it to run. The catalog is curated by
the environment's operator; an empty catalog means no reviewed packages have been published
there. The catalog lists packages already on that environment, rather than downloading from
a remote marketplace. Installed packages remain pinned to their approved contents; editing
one causes a load error even if its catalog entry has been removed.

You can also add your own extension directory under the environment's `userdata/plugins`
directory. Each extension needs a `plugin.json` manifest. It appears in Settings after
discovery and starts disabled. See [plugin development](../operations/plugins.md) for the
module format.

Enabled extensions with web code run in each web or desktop client only after that client
approves them. Choose **Trust this version** to approve the displayed SHA-256 contents for
that environment and connection origin. Changed contents require new approval.
For your own local directory, **Trust local development** allows future edits in that
directory to run automatically. **Revoke trust** removes approval from this client without
disabling the extension on the environment or other devices.

Enabled local extensions reload when their files change; changed web code waits for the
client's approval unless local development is trusted. Use the extension's reload action
to retry a load, or **Refresh** to discover new directories. A failed replacement on the
environment keeps its previous working generation active and shows the load error. Disable
an extension to remove its contributions. Existing custom panel tabs remain available to
close or reopen after the extension is enabled again.

Bundled interface features can also be disabled or replaced. If disabling a feature hides
navigation or settings, open **Plugin recovery** or press **Ctrl/Command+Alt+P** to restore
it. Recovery stays available independently of interface plugins.

Extensions can change interface features, add panels, and run commands on the environment.
Run only code you trust. Server extensions execute with the server process's filesystem and
network access. Approved web code can read conversations and stored credentials, act on
connected environments, and use the desktop bridge. Permission declarations and catalog
review are not an operating-system sandbox.

Web extensions run in the web and desktop clients. Mobile extensions can download
declarative interface trees that compose the app's existing controls and callbacks.
Compiled React Native modules must be bundled into the app and require a rebuild.
Installing a web extension does not make its JavaScript run inside the native client.

The desktop client also shows **Desktop plugins** in Settings > Plugins. These run on
that computer and keep their enabled state independently of connected environments.
Plugin recovery can restore desktop plugins as well.

## Claude Code plugins

To load a native Claude Code plugin, open **Settings > Providers**, select the environment,
and add its directory under the Claude instance's **Plugin directories**. Enter one path per
row, without shell quotes, including paths containing spaces. The directory must exist on
the environment's machine. `~` uses that machine's home directory; relative paths use the
thread's workspace. Remove a row to stop loading that directory in new Claude sessions.

These directories use Claude Code's plugin format, including `.claude-plugin/plugin.json`.
They provide Claude's native skills, commands, agents, hooks, and MCP servers. Configure
them separately from the T3 Code interface extensions in Settings > Plugins. The existing
`--plugin-dir` launch argument remains supported; use the directory list for multiple paths.

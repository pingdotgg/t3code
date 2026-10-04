# Plugins

A plugin is a directory of JavaScript with a `t3-plugin.json` manifest. Each environment runs its own
plugins: they live on the server's machine and run there, not on the device you manage them from.

Plugins are trusted local code, not a sandbox. An enabled plugin runs as your user account on the
server's machine, with the same access to its files, programs, and network. Only add code you trust.

## Adding a plugin

Open **Settings** > **Plugins** in the web or desktop app. Each environment whose server supports
plugins has its own list. Choose **Add plugin** and enter the absolute path of the plugin directory
on that environment's machine. Adding reads the manifest and the files; nothing runs yet.

Review the plugin before it runs: the review shows the plugin ID, its directory, the number and size
of its files, a digest of their exact contents, and the capabilities it declares. Confirm that you
trust it, then **Approve and enable**. The plugin starts the first time it is used.

Add a plugin's build directory, not a git checkout. Every file in the directory counts, hidden files
included, and symbolic links are refused.

## When a plugin changes

Your approval covers the exact files you reviewed, declarations included. When a file check finds
that a file in the directory changed, T3 Code stops the plugin, disables it, and shows **Changed
since approval** until you review it again. A plugin that writes into its own directory is therefore
stopped at the next check; plugins must keep their data elsewhere.

T3 Code checks the files when you add, approve, or enable a plugin, when the server starts, and
before a call starts the plugin. A plugin that is already running is not checked again until one of
those points, so use **Check files again** after you change a directory.

The digest records what you approved. It does not stop the directory's owner from changing it, and
code a plugin loads from outside its directory is not covered.

## Managing plugins

Disable stops a plugin without forgetting your approval. Remove stops it and forgets it, including
its saved settings and storage. A directory you added is never deleted; a plugin installed from npm
has its downloaded files deleted once it has stopped. Both are always available, even when the
directory is gone.

A plugin that crashes waits briefly before its next start, and is stopped after repeated failures.
A plugin that cannot run on this version of T3 Code is marked **Incompatible**. A plugin that
receives events shows how delivery is going beside its state; when delivery keeps failing it stops
until you resume it, and no events are skipped. Fix the problem, then choose **Resume**.

Managing plugins needs administrative access to the environment. A browser paired with a standard
link can see the plugins but not change them; pair it with an administrative link to manage them.

The mobile app shows plugins read-only, under **Settings** > **Server settings** > **Plugins**: their
state, event delivery, and details. Add, approve, enable, or remove them from an administrative web
or desktop connection.

## Writing a plugin

The manifest names the plugin and its entry module:

```json
{
  "id": "example.board",
  "name": "Board",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "main.mjs",
  "capabilities": ["actions"],
  "proposedApi": true
}
```

The entry module exports `activate(context)`, and may export `deactivate()`. Everything below is
part of the proposed API: list each capability you use in `capabilities`, set `"proposedApi": true`,
and use `context.proposed`. A manifest T3 Code cannot honor is refused when the plugin is added, with
the reason. Each `context.proposed.handle(name, handler)` registers one entry point the server calls.

### Events

With the `events` capability, `context.proposed.onEvent(handler)` receives the environment's
`run.finalized` and `run.finalization-failed` events, in order. Register it during `activate`.
Delivery is at least once: a handler that throws gets the same events again later, so deduplicate
side effects by `event.deliveryId`, and ignore event types you do not know.

### Tools

With the `tools` capability, a plugin offers tools that agents call through T3 Code's own MCP server.
Declare each tool in `tools` with a `name`, `description`, `inputSchema` and `sideEffect` (`read`,
`write` or `destructive`), and answer with `context.proposed.handle("t3.tool.<name>", handler)`. The
handler receives `{ input, context: { environmentId, threadId } }`. `inputSchema` must stay within
the JSON Schema subset T3 Code enforces, and input that does not match it never reaches the plugin.

Agents see two tools in every session that uses T3 Code's MCP server: `plugin_tools_list` and
`plugin_tool_call`. A session can use the plugins that were enabled when it started; start a new
thread to use one enabled later. Disabling or removing a plugin refuses its tools at once in every
session and cancels calls in progress.

### Settings and storage

With the `settings` capability, list up to 32 fields in `settings`. Each has a `type` (`text`,
`secret`, `boolean`, `number` or `select`), a unique `key` and a `label`, and may have a
`description`. Every type except `secret` can have a `default`; `number` can set `min`, `max` and
`integer`, and `select` lists its `options`:

```json
"settings": [
  { "type": "text", "key": "apiUrl", "label": "API URL", "default": "https://api.example.com" },
  { "type": "secret", "key": "token", "label": "API token" }
]
```

Settings are saved from an administrative connection with the `plugins.settings.update` request.
`context.proposed.settings.get(key)` returns the saved value if it still fits the field, else the
default, else `undefined`. Secrets are write-only for clients: a client learns only whether one is
saved. T3 Code stores each secret as a plain-text file, readable only by your user account, in the
server's secrets directory. It is not encrypted.

`context.proposed.storage` keeps JSON values with `get`, `set`, `delete` and `keys`: keys of 1 to
128 characters, values up to 64 KiB, at most 256 keys and 1 MiB per installation. A write past a
limit rejects.

Settings, secrets and storage survive disabling, restarts and file updates. A value for a field a new
version no longer declares, or switches between secret and non-secret, is deleted at the next save.

### Actions

With the `actions` capability, declare up to 16 actions in `actions`. Each has a `name` (lowercase
letters, digits and dashes; also its slash command), a `title`, an optional `description`, a
`target` (`environment`, `project` or `thread`) and its `placements`: `command-palette`,
`thread-menu` or `composer-slash`. Answer with `context.proposed.handle("action:<name>", handler)`;
the handler receives `{ action, target }` and may return `{ message }`, shown as a toast on web and
desktop or an alert on mobile. Throw to report a failure. An action fails after 30 seconds.

Picking an action runs the plugin's code at once. It does not write a prompt or start an agent turn.
An action appears only where its target is known: the command palette for the environment and the
project or thread you are in; the thread menu in the sidebar, the chat header, or under **Plugin
actions** in a thread's long-press menu on mobile; and the composer's `/` menu, which in a new,
unsent thread shows only environment and project actions. An action picked from a list that has
since changed is refused; open the menu again. If an environment's plugins declare more than 128
actions, the plugins that do not fit are left out whole.

### Views

With the `views` capability, declare up to 8 views. Each has an `id`, a `title`, the placement
`side-panel`, one `script` and an optional `style`, together at most 1 MiB. An enabled plugin's views
open as tabs in the right panel of the web and desktop apps, from its empty launcher and its **+**
menu. Views are not available in the mobile apps yet.

A view runs in an isolated frame. It cannot read T3 Code's pages, storage or connection, load other
files, or reach the network; inline images and fonts as `data:` URLs. Its script finds `t3View` on
`window`: `t3View.ready` resolves once connected, and `t3View.call(handler, input)` reaches
`context.proposed.handle("view:<view id>:<handler>", handler)`. Inputs and answers are JSON of at
most 64 KiB, and a call fails after 30 seconds. A view that floods messages or stops answering is
stopped; **Reload** in its tab starts it again. Disabling or removing the plugin, or a file check
finding it changed, closes its views on every client, and they come back when it is enabled again.

## Installing from npm

T3 Code can install a plugin from an npm registry instead of a directory. Installing runs nothing:
the plugin waits for your approval like any added directory. Until the clients offer this, use an
administrative connection and the `plugins.npm.*` requests. A standard pairing can list npm packages
but not install or update them.

`plugins.npm.add` takes a package `name` and an exact `version` or a dist-tag such as `latest`;
ranges are refused, and the resolved version is recorded. `registry` is optional and defaults to the
public npm registry. Another registry must use `https`, except one on this machine (`localhost`,
`127.0.0.1` or `[::1]`), because over plain `http` the published integrity and the tarball could both
be replaced in transit. Registries that need a login are not supported, and `.npmrc` is not read. Before
anything is written, T3 Code checks the registry's `sha512` integrity, the tarball's size and paths,
and that `package.json` has the requested name and version, no install scripts, no native build, and
every runtime dependency bundled. Publish `t3-plugin.json` and the code at the package root, and list
runtime dependencies in `bundleDependencies` or bundle your code into one file.

Updating takes two steps, so a new version never runs without your approval.
`plugins.npm.stageUpdate` downloads and checks a version next to the installed one, which keeps
running, and replies with its manifest and digest. `plugins.npm.applyUpdate` with that digest
approves those exact files and swaps them in; if anything fails first, the old version is put back.
`plugins.npm.discardUpdate` drops a staged update. Removing an npm plugin deletes its downloaded
files once it has stopped.

# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), typed with
[`@t3tools/plugin-sdk`](../../packages/plugin-sdk).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) runs plugins and
[`PluginInstaller`](../../apps/server/src/plugins/PluginInstaller.ts) installs them.

## Trust and failure

Plugins are trusted code the user chose to install. Server entries run in the server process and web
bundles run as React code in the page with every connection's credentials, with no sandbox. Manifest
`permissions` are shown on the plugin's row and not enforced, and `settings.get()` hands plugins
secret values in plain text. Do not shape the API around a future sandbox.

The host isolates failure instead. A plugin that throws while starting, or whose start doesn't
settle in 30 seconds, is marked failed, and a throw in a handler fails that call. Node exits on a
rejection nobody handles, so every promise the API hands a plugin comes from `call` or `refused` in
[`facade.ts`](../../apps/server/src/plugins/api/facade.ts), which mark it handled.

Plugin code can still fail where nothing T3 runs is waiting, such as in a timer or a child process
with no `'error'` listener. The [failure guard](../../apps/server/src/plugins/pluginFailureGuard.ts)
ties such a failure to a plugin when it can. A plugin's unhandled rejection becomes that plugin's
`serverFailure`, and Node does not exit. The plugin stays active. Disabling or reloading it releases
what it registered through the API, but timers it started itself keep running, and Node keeps its
code until the server restarts. This is accepted because the user chose to install that code, and
the alternative is one plugin bug stopping the server and every running agent.

An uncaught exception still stops the server, because Node calls resuming after one unsafe. When the
guard ties one to a plugin, it saves the error to `plugins.json` before Node exits. The next start
lists that plugin as failed with its switch off until the user turns it on again, so a plugin that
throws at startup can't stop every start. A failure the guard can't tie to a plugin
stops the server too.

Some failures end the process before any handler runs: `process.exit`, running out of memory, a
native crash, or a loop that never yields while the plugin starts, which no deadline can interrupt.
So the host writes a starting mark to `plugins.json` before it loads and activates a plugin, and
clears it after. A start that finds a mark left behind turns that plugin off and says why.
`--no-plugins` lists plugins but runs none, so a user can always reach Settings to turn one off.

The host runs plugin code in an `AsyncLocalStorage` scope, which Node carries into the timers and
callbacks that code starts, so a failure with only Node's frames in its stack is still the plugin's.
Before Node 24 that scope slows every promise in the process about 3x, so the host fails plugins
with a server half there as incompatible, though the server still allows Node 22.16+ and 23.11+.
Plugins without one still run.

## The API and manifests

The server bundle inlines `effect`, so plugins never share the host's Effect runtime or `Schema`
instances. They get Promises, `AsyncIterable` streams, `AbortSignal` and the SDK's own types, never
T3's contracts, which change between releases.

`plugins.invoke` and `plugins.subscribe` need only the read scope, so the host checks a method's
`access` itself: a `write` method needs the caller's operate scope, as T3's own changes do. A call
fails after 30 seconds and aborts the handler's signal, so a handler that never answers can't hold
a client's call open. An agent's tool call gets 5 minutes, because a tool may do real work, then
fails the same way with an error the agent reads, so a hung tool can't hold the turn. Each
subscriber gets its own sliding buffer per channel, so a busy channel or a slow subscriber drops
only that channel's oldest values.

Manifests accept keys they don't know, so a newer manifest still loads on an older T3. The
plugin's row names the keys T3 ignored, so a typo such as `setingsSchema` shows.
`engines.t3` is how a plugin requires a newer T3: the server refuses to install or start a version
outside it. `api.version` is how a plugin detects newer API members and still runs on older
releases, so a change that adds a member raises it and names that version in the member's doc.

Discovery and install compile the manifest's `settingsSchema`, so a schema T3 can't validate fails
the plugin with the reason instead of refusing every save later.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags, dev paths, the plugins that stopped the server and
starting marks.
Settings go in `plugin-data/<id>/` and storage in `plugins.sqlite`. They stay out of
`settings.json`, whose writer drops keys it doesn't know, and out of `statev2.sqlite`, which holds
T3's event-sourced state: plugin data isn't events, has no schema of T3's, and is deleted with its
plugin. Settings stay
out of `plugins/<id>/`, so replacing a plugin's files keeps them. Removing a plugin deletes its
settings, secrets and storage, so nothing is left that no plugin can reach.

All of a plugin's secrets share one secret store entry, because a keychain can't list names and
removal must also find the secrets of fields a plugin has since renamed. The settings store keeps
each plugin's files in memory after the first read and changes them only through its own writes,
so a hand edit to `settings.json` shows after a restart.

## Installing

Installs copy into `plugin-staging/`, outside `plugins/`, so discovery never sees a half-written
plugin. Only the swap takes the lifecycle lock, so a slow copy does not block other plugins. The
old version waits in staging until the new one starts and goes back if it fails.

Clients upload a dropped folder's files, never its path, which would mean nothing on a remote
environment. They post them over HTTP to a URL `plugins.createUploadUrl` signs for 5 minutes,
because one large WebSocket message holds up every other stream on the socket. As for attachments,
the signature is the credential, so the upload works the same on every kind of connection. Each URL
installs once. The server keeps its unused URLs in memory, so a restart refuses those it signed
before.

Discovery takes the id from the manifest, because people copy plugin folders in by hand. Settings,
storage and the enabled flag belong to the id, so a later folder with an id already listed fails as
a duplicate. An id that several folders share is one failed row naming each folder, and no copy
runs until the user deletes the extras. It has no Remove, because removal deletes the id's data,
which the copy kept would need. After a discovery that read every folder, the host forgets the
enabled flag and crash record of every id no folder has, so a folder copied in later with that id
starts off. A folder it can't read, such as one on a drive that isn't mounted, keeps its flag and
gets a failed row. Nothing watches `plugins/`: the server reads it at startup, on reload and
when Settings asks.

## Clients

Each browser keeps its own choice of the environments it loads plugin UI from, the main one by
default, because that code runs with every connection's credentials. Right panels show only in their
environment's threads. Commands and styles have no thread, so a plugin on in several chosen
environments adds them from the first, and the next takes over when it's turned off there.

The parts a plugin can redraw sit on hot paths: the composer's control row, the sidebar and the
Settings and Usage frame. Each host draws its part through
[`PluginPart`](../../apps/web/src/plugins/PluginPart.tsx), which keeps T3's own element until a
loaded plugin replaces that part, so the tree under it never remounts while none does and the
registry stays out of startup. The composer fold works the same way: the timeline reports leaving
its end only while a plugin asks for the fold, so threads pay nothing otherwise.

Rows carry `hasSettings` rather than the settings schema. Every client, read-only ones and the
idle watcher included, gets the whole list again on each status change, and only the settings
form needs the schema, which it fetches with `plugins.settings.get`. The list decodes row by row,
so a row an older client can't read, such as one with a newer failure stage, is left out and the
rest still shows.

A user with no plugins shouldn't pay for them at startup. What loads with the app is the plugin RPC
schemas, which are part of the app's RPC group, the cache that paints published themes from the
first frame, and the small pieces app code reads plugin parts through, such as the
[`pluginUi.ts`](../../apps/web/src/plugins/pluginUi.ts) stub. The rest loads behind
[`PluginLoaderStarter`](../../apps/web/src/plugins/PluginLoaderStarter.tsx). Once the app is idle,
or at once in a browser where plugins changed the layout last time, it downloads a watcher that
follows `plugins.subscribeStates` for each chosen environment, a stream of its own because the
server config stream would resend the whole config on every plugin change. It downloads the web
loader only when an active plugin has a web part, and a separate styles chunk only when one has a
`styles/` folder. The server starts plugins after it is listening.

A bare `import(url)` cannot send credentials, so the loader fetches each bundle with the
connection's credentials and imports it from a `blob:` URL, which the desktop CSP allows. Mobile
release builds cannot load code, so the mobile app shows no plugin UI, settings or themes.

Bundles get React, the UI kit, `Atom` functions and atom hooks from `globalThis.__t3PluginHost`,
because a second React or effect would not share T3's renderer or atom registry. The SDK declares
its own atom types, so a plugin needs no `effect` and T3's effect upgrades don't break its
typecheck. No type check compares those types with effect's. Instead the `hello-web` fixture
typechecks against the SDK's types, and `pluginLoader.browser.test.ts` runs its settings panel on
effect's functions, so an effect upgrade that changes one the fixture uses fails there. A change to
a shared function or hook needs a matching change in the SDK's `atom.ts` or `atom-react.ts`.

Plugin themes arrive over the server config stream after the first paint, so the client saves them
in localStorage for the boot script in `index.html`. The server marks plugin themes, so the client
can show only those of chosen environments. The desktop main process cannot read localStorage, so
the page sends it the canvas it paints under a light and a dark native theme.

## Agent tools

MCP servers can't remove a tool, so each plugin tool registers with an `EnabledWhen` check that the
server runs on every list and call. A stopped plugin's tools leave new listings and answer as not
found.

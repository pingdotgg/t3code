# Plugin development

Start with the running environment's `plugins_authoring_guide` MCP tool. Its overview
returns the supported building blocks, recipes, and actual plugin directory. Request a
recipe with your manifest id, for example
`{"topic":"thread-panel","id":"local.sidechat"}`, to obtain ready-to-save UI starter
files. Inspect the requested reference in the app and preserve its existing actions.
Explicit requests for a different layout or behavior can replace the relevant pieces.

The `service` and `provider` topics provide contract guidance rather than starter files.
The service topic includes the live server service catalog; inspect the owning contract
before wrapping or replacing it. Use the normal thread renderer and provider picker for
T3 conversations, and the controlled UI components when another service owns the history
and transport.

Use an isolated T3 home for development. A local extension lives at
`<stateDir>/plugins/<directory>/plugin.json`, where `stateDir` is the active environment's
userdata directory. New local extensions start disabled; enable them in Settings > Plugins.
Symlinks are rejected. Keep entry files and relative dependencies inside the extension.

```json
{
  "id": "local.project-banner",
  "apiVersion": 1,
  "name": "Project banner",
  "version": "1.0.0",
  "iconUrl": "https://example.com/project-banner/icon.png",
  "sourceUrl": "https://github.com/example/project-banner",
  "permissions": ["ui", "routing", "actions"],
  "entries": { "web": "web.js", "server": "server.js" }
}
```

Optional `iconUrl` and `sourceUrl` provide a plugin icon and a link to its source.
Use absolute HTTP(S) URLs of at most 2,048 characters. These fields do not change
plugin trust or catalog fingerprint validation.

## Web and desktop

Enabling an extension on the environment does not approve its web code in connected clients.
Each web or desktop client saves its own approval for the environment, connection origin,
plugin id, and captured content hash. **Trust this version** requires approval again when
the tree changes. For local authoring, **Trust local development** instead approves future
edits in that exact local directory. **Revoke trust** unloads its web contributions in that
client; it does not disable server code or revoke other clients' approvals.

Web and server entries accept JavaScript, TypeScript, JSX, and TSX source. The host
compiles a copied generation before activation. Normal `react` imports and automatic
JSX use the client's own React; supported Effect imports use the host's Effect instance.

The public SDK has process-specific type entry points at `@t3tools/plugin-sdk/web`,
`/server`, `/native`, and `/desktop`, with identifier and manifest schemas at `/contracts`.
Use `import type` for the host API. The root `definePlugin` helper preserves an activation
function or definition's type. Source exports live in
[the SDK package](../../packages/plugin-sdk/package.json); editor typechecking needs the
SDK package, while the host compiler erases type imports without fetching dependencies.

```tsx
import { definePlugin } from "@t3tools/plugin-sdk";
import type { PluginPanelProps, WebPluginHost } from "@t3tools/plugin-sdk/web";

export default definePlugin((host: WebPluginHost) => {
  function Notes({ threadRef }: PluginPanelProps) {
    return <p>{threadRef.threadId}</p>;
  }
  host.panels.register([{ id: "notes", title: "Notes", component: Notes }]);
});
```

A contribution without an id uses the default id and replaces its slot. When several
plugins replace that default, the last contribution wins; replacements do not form a
wrapper chain. Other ids add content before the default
when `order` is negative, or after it otherwise. `host.builtin(slot)` returns the original
renderer, including deferred renderers whose route or panel has not loaded yet. Preserve
its props when composing around it. Augment `PluginFeatureProps` in
`@t3tools/plugin-sdk/web` with a feature's exact props, or use the generic
`host.builtin<Props>(slot)` after inspecting its owning contract.

For a notice above the existing composer, request the `composer-banner` recipe and
register a unique id at `chat.composer.banners`. Each contribution receives
`{environmentId, threadRef}`; `threadRef` is null for a draft. Keep data subscriptions
inside its component and render the real notice through `host.ui.chat.BannerStack`:

```js
export function activate(host) {
  const h = host.React.createElement;
  function ThreadContext({ threadRef }) {
    if (!threadRef) return null;
    return h(host.ui.chat.BannerStack, {
      items: [
        {
          id: "thread-context",
          variant: "info",
          icon: null,
          title: "Thread context",
          description: threadRef.threadId,
        },
      ],
    });
  }
  host.register([
    {
      slot: "chat.composer.banners",
      id: "thread-context",
      component: ThreadContext,
    },
  ]);
}
```

This additive slot retains the native composer and other plugins' notices. For usage
or other live data, read it through existing services or `host.invoke`; do not replace
`chat.composer` to add a banner. Banner items also support actions, children, and dismissal.

Use `host.ui.chat.Thread` with a durable `threadRef` to embed the normal chat view
in a panel. It keeps the native model, effort, speed, permissions, attachments,
timeline, and turn controls. An optional `contextThreadRef` includes that thread
as read-only context on each send. Focus and shortcuts stay with the selected
conversation; rendering a side thread does not navigate away from the main one.

Use the controlled `host.ui.chat` components for a conversation whose transport
and history belong to a different service.
`Topbar` and the breadcrumb components share the main header layout. `Timeline`
accepts `{ conversationId, environmentId, messages, pending }` and renders the real
virtualized message rows; each message has `id`, `role`, `text`, `createdAt`, and
optional `streaming`. Give it its own stable conversation id, distinct from the
source thread. `Composer` accepts `value`, `onChange`, `onSubmit`, `onInterrupt`,
optional `pending`, `busy`, `disabled`, `placeholder`, `ariaLabel`, and `controls`.
It uses the same editor, surface, and send/stop controls as the main composer.
These controlled components do not dispatch thread commands; the plugin owns
its transport and history. `ComposerSurface`, `PromptEditor`, and `PrimaryActions`
are also available when composing a different layout. Components load on demand
and participate in the normal feature registry.

Every application component, including shared controls, has a discoverable component slot
of the form `component:<src-relative-module>/<Name>`. `host.features()` lists loaded
slots and their owners. File-route component, pending, error, and not-found renderers use
`route:<file-route-path>/<renderer>`. Named feature slots such as `chat.composer` remain
available for broader replacements. Builtins and external components register through the
same registry; the host bootstrap and recovery controls remain available independently.

Markdown element renderers expose `markdown.element.<tag>` slots with their original
React Markdown props. Diff callbacks expose `diff.header.metadata`,
`diff.header.filename-suffix`, `diff.header.prefix`, `diff.footer`, and `diff.annotation`.
These receive live file metadata and the current rendering callbacks or annotation children,
so replacements can preserve the existing controls and actions.

Routes, navigation, and command-palette actions use the live contribution registry:

```js
export function activate(host) {
  host.routes.register([
    {
      id: "overview",
      title: "Project overview",
      component: () => host.React.createElement("h1", null, "Project overview"),
    },
  ]);
  const path = host.routes.path("overview");
  host.navigation.register([
    { id: "overview", title: "Project overview", path, location: "sidebar" },
  ]);
  host.actions.register([
    {
      id: "overview",
      title: "Open project overview",
      shortcut: "mod+alt+o",
      run: ({ navigate }) => navigate(path),
    },
  ]);
}
```

Declare `routing`, `ui`, and `actions` permissions for the corresponding registration
APIs. Navigation locations include `sidebar` and `settings`. Route paths carry their
environment selection. Action handlers receive that environment, the active thread when
invoked from the palette, and a navigation function. `host.navigation.open(path)` opens
a local route after activation. Registration is staged and removed with its generation.
An action can declare `slashCommand: "side"` to appear as `/side` in the composer.
Selecting or submitting the standalone command runs the action without sending a provider turn;
existing built-in and provider command names take precedence. Set `requiresThread: true`
when the action needs an existing thread.

Register features, panels, and `host.style(css)` during activation. Panel controls appear
in the thread's add-panel menu; `host.panels.open(threadRef, id)` is available after activation
and accepts threads from the extension's own environment. `host.invoke(method, input)` calls
that extension's server commands. Return a cleanup function or use `host.onDispose` for
listeners and other resources. Cleanup runs on replacement, disable, or host disposal.

With `client:services` permission, `host.services.list()` discovers the connected
environment's live client service keys and members. `get(key)` returns the current facade;
`getBuiltin(key)` accesses the original service. `register(key, factory)` adds a service
whose key starts with the manifest id followed by `.` or `/`. `replace(key, factory)` and
`wrap(key, member, run)` register service contributions during activation. A replacement
factory receives `{ original, services, Effect, Stream, Scope }` and may return a service,
an Effect, or a promise. A wrapper receives `(args, next)` and must preserve its member's
return contract. These contributions apply only to the extension's environment bindings.
Active Effect, Stream, and promise calls retain their generation until completion, so
replacement or disable does not dispose resources underneath in-flight calls.

Global client services, such as persistence, connection coordination and native widget
publication, use `host.services.host` with the separate `client:host-services` permission.
Its `list`, `get`, `getBuiltin`, `register`, `replace` and `wrap` methods select the client's
host scope explicitly. Changes affect every connected environment in that client.

`host.style(css)` scopes selector rules to the extension's environment using native CSS
`@scope`. Rules do not target nested surfaces from another environment; normal CSS
inheritance still applies. Use `:scope` for root
tokens, for example `host.style(":scope { --project-accent: teal; }")`. Document-wide rules,
imports, and font declarations are outside this styling API's contract. Elements portalled
outside the environment root, including body-mounted menus and dialogs, are outside its scope.

Activation and service staging have 10-second deadlines. Native staging cancels when its
environment disconnects or the requested generation changes. A failed replacement keeps
the working generation. Native and desktop cleanup callbacks share a 10-second deadline.
Direct top-level module side effects cannot be rolled back; acquire resources in activation
and register their cleanup.

The environment serves the compiled generation over scoped asset URLs, so relative source
imports work for local and remote clients and reload with their generation. The compiler
supports `react` and its JSX runtimes on web, the SDK root and `/contracts`, and
`effect` plus `effect/Context`, `effect/Effect`, `effect/Layer`, `effect/Option`,
`effect/Schema`, `effect/Scope`, and `effect/Stream`. Node builtins are supported on server.
Other dependencies must be bundled beforehand or vendored with relative imports inside
the plugin directory. The compiler does not resolve arbitrary bare packages, host
`node_modules`, development-server paths, or symlinks. Keep the captured tree within
2,000 files and 16 MiB; compilation has a 10-second deadline and 16 MiB input/output
limits. Code and JSON imports are supported; use `host.style` for CSS.

## Server commands and providers

Declare `server:events` to subscribe during activation with
`host.events.on({ eventType?, threadId? }, handler)`. The host delivers committed
orchestration events after activation, sequentially per subscription. Handler errors
are logged and delivery continues; a bounded buffer overflow stops that subscription.
Disabling or disposing its generation stops delivery. This callback runs after the
orchestrator commits, so it cannot change the event being observed.

Server entries export `activate(host)` or a default object with that method. The host supplies
Effect and Schema so extensions share the server runtime:

```js
export function activate({ Effect, Schema, commands }) {
  commands.register("greet", {
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.String,
    run: ({ name }) => Effect.succeed(`Hello, ${name}`),
  });
}
```

Use `host.onDispose` for module resources. Commands validate declared input and output
schemas. Server activation has a 10-second deadline. Commands retain their generation until
they finish. Replacements are built before the working generation retires. Registered
cleanup callbacks share a 10-second deadline. Generation files are pruned, but the JavaScript
runtime retains imported module objects until the process restarts.

Provider extensions declare `"server:providers"` in manifest permissions and call
`host.providers.register(driver)` during activation. Drivers implement
[ProviderDriver](../../apps/server/src/provider/ProviderDriver.ts), including metadata,
a configuration schema, and a scoped `create` factory. Each factory owns its instance's
processes and state and releases them when its scope closes. Active instances retain their
driver generation. Replacing or disabling a driver preserves its active turn and finite
operations, including text generation, workspace discovery, authentication and ACP calls.
New turns stop on its old generation. Replacement waits until sessions and operations drain;
change subscriptions do not delay replacement.

Registering a new driver does not create an instance. Add an entry to the environment's
`settings.json` under `providerInstances`, for example
`"custom": { "driver": "custom", "config": {} }`. Its config must match the driver's
schema; omit `config` to use `defaultConfig()`. Configured instances then appear in provider
settings and model selection. A driver that overrides a builtin kind uses that kind's
existing instances. `host.providers.getBuiltin(kind)` returns the bundled driver for wrappers.

`host.commands.wrap(pluginId, method, run)` requires `"server:commands"` and intercepts
supported unary websocket commands. Streaming calls and HTTP, MCP, and scheduler callers
of builtin services bypass these wrappers. These declarations control SDK registration;
in-process server code still has the server's full privileges.

With `server:services` permission, `host.services.list()`, `get()`, `getBuiltin()`,
`register()`, `replace()` and `wrap()` expose the actual factories used across transports
and background work. Factories receive the same context described for client services.
New service keys must start with the manifest id followed by `.` or `/`.

Replacements update retained service facades. Multi-output factories expose their actual
Context tags individually and keep their shared resource owner private. Leaf generations
retain that owner's resources until active calls finish. Disabling and re-enabling rebuilds
the shared factory and its current leaf services. Consumers that already copied plain scalar
values still require rebuilding their runtime. The kernel, admission and recovery plane,
and startup configuration remain the
host bootstrap. Essential host owners reject disabling before changing saved preferences;
their service implementations can still be replaced.

## Reviewed catalog

The environment operator owns `<stateDir>/plugin-registry.json`. Entries contain the reviewed
manifest, a `sourceDirectory` relative to `stateDir`, its full-tree `sha256`, a publisher
`{id, name}`, and a review `{reviewer, reviewedAt, summary?}`. Review metadata is separate from
the extension's manifest. This local catalog performs no remote downloads.

Use `PluginCatalog.fingerprint({sourceDirectory})` to obtain the hash for a reviewed tree.
Its format hashes `t3-plugin-tree-v1\0`, then each file in sorted relative-path order:
UTF-8 path byte length plus NUL, path bytes, content byte length plus NUL, and content bytes.
The tree includes `plugin.json`. Packages are limited to 2,000 filesystem entries and 16 MiB.

Catalog installation rejects changed hashes, manifest mismatches, missing entry files,
symlinks, and existing destination directories. It copies captured reviewed bytes into a
staging directory and renames the copy into the local plugins directory, disabled. Source
changes require a new review and fingerprint.

The environment saves installed hashes in `<stateDir>/plugins-installed.json` and verifies
captured bytes on each reload, before executing server entries or serving client assets.
Removing a catalog entry does not turn its installed package into an editable local plugin.
Changed installed bytes are rejected; restore the approved tree to load it again.

## Desktop host modules

Desktop modules declare `entries.desktop` and live in the desktop host's
`<stateDir>/plugins/<manifest-id>` directory. Their enabled state is independent of
connected environments and is managed in Settings > Plugins > Desktop plugins.
They start disabled. Saved files reload through immutable generations.

Desktop activation supplies Effect, Schema, scoped service registration and commands.
Declare `desktop:services` to add, replace or wrap desktop service factories.
Web companions can call `host.desktop.invoke(method, input)` for commands registered
by their own manifest id. `host.desktop` is null in clients without a desktop bridge.
Plugin recovery includes desktop controls so failed interface contributions can be restored.

## Native mobile

Native interface extensions can provide a bounded declarative JSON component tree through
their mobile entry. The connected environment serves immutable generations of that tree;
enabled extensions reload when their files change. Trees can compose the client's real
registered primitives, replace builtin interface trees, and preserve their existing callbacks
through prop references. They do not execute downloaded JavaScript.

Compiled React Native extensions are explicit Metro-bundled modules in
[local.ts](../../apps/mobile/src/plugins/local.ts). They implement
[NativePluginDefinition](../../apps/mobile/src/plugins/sdk.ts), use the supplied React and
React Native instances, and register cleanup through `host.onDispose`. The definition's
manifest id must match an installed extension on the connected environment. Its enabled
state and active status determine whether that environment's native contributions load.
Metro fast refresh updates these bundled development modules. Adding or changing native
packages requires rebuilding the app.

## Native Claude Code plugins

A Claude provider instance accepts a `pluginDirectories` string array in its configuration.
Use **Settings > Providers > Plugin directories** to edit it. These are native Claude Code
packages with `.claude-plugin/plugin.json`, independent of this guide's T3 Code manifest
and reviewed catalog. Paths are local to the environment; `~` expands there and relative
paths resolve from the thread workspace. The session passes them through the Claude SDK's
local plugin option, alongside an existing single `--plugin-dir` launch argument.
Capability discovery loads their commands with hooks and plugin MCP discovery disabled.

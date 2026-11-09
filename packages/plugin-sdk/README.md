# @t3tools/plugin-sdk

Types and build helpers for T3 Code plugins. A plugin is a folder with a `t3-plugin.json` manifest,
an optional server half that runs inside the T3 Code server, and an optional web half that runs in
the web and desktop apps. Plugins are trusted code: they run with the same access as T3 Code.

[`examples/quick-notes`](./examples/quick-notes) is a plugin to copy from. It builds its web half
instead of committing it: run `vp run build:examples` in `packages/plugin-sdk` before adding it to
T3 Code, which builds it to `dist/web.js` with the Vite preset below. The plugins in
[`fixtures/`](./fixtures) back the tests and are small and working too. They are written by hand
and need no build. `hello-web` uses most of the web API.

## Install

The SDK isn't on npm yet. Build it from a T3 Code checkout: run `vp run build` in
`packages/plugin-sdk`, then `npm pack` in its `dist` folder. Install the `.tgz` file it writes in
your plugin with `npm install --save-dev <path to the .tgz>`. `dist` holds the whole package as it
will be published.

The SDK has no dependencies of its own. What else a plugin needs depends on its parts:

- A web half needs `react` and `@types/react` as dev dependencies, plus `react-dom` if it imports
  it, and Vite 8 or later to build it. The bundle uses T3's own React at runtime, but the build
  reads React's exports.
- Typechecking a server half needs `@types/node`.

## Manifest

```json
{
  "id": "hello-web",
  "name": "Hello web",
  "version": "0.1.0",
  "description": "Shown on the Plugins page.",
  "engines": { "t3": ">=0.1.6" },
  "server": "./server.cjs",
  "web": "./web.js",
  "settingsSchema": {
    "type": "object",
    "properties": { "token": { "type": "string", "format": "t3-secret" } }
  }
}
```

- `id` uses lowercase letters, digits and hyphens, starts with a letter and has up to 32
  characters. It names the plugin's folder, its agent tools (`plg_<id>_<tool>`) and its keybinding
  commands (`plugin.<id>.<command>`).
- `engines.t3` is a version range made of `^`, `>=`, `>`, `<=`, `<`, `=` and `||`, such as
  `>=0.1.6`. A server outside it refuses to install the plugin or start it, and says why.
- `permissions` is an optional list of what the plugin says it uses. Settings → Plugins shows it on
  the plugin's row, and T3 Code doesn't enforce it.
- `server` must be CommonJS ending in `.cjs`. `web` is a single-file ES module. A plugin with a
  `server` runs only on a T3 Code server running Node 24 or later, such as the desktop app's. On
  an older Node, such as `npx t3` on Node 22, it fails to start and says why.
- `settingsSchema` is JSON Schema. T3 Code draws a form from it on the Plugins page, and top-level
  string fields with `"format": "t3-secret"` are stored in the server's secret store and never shown
  again. `t3-secret` anywhere else is saved as plain text. The form covers top-level strings,
  numbers, integers, booleans, `enum`s of strings or numbers, and arrays of strings. One property
  of any other shape, such as an object or a nullable type, turns the whole form into a JSON box.
  Every save is checked against the schema with the top-level `default`s filled in, so a default
  its own field rejects refuses every save. A schema T3 Code can't validate against fails the
  plugin when T3 Code finds or installs it, and says why. Any session that can read the
  environment can read the settings, a guest's read-only session included, and only `t3-secret`
  fields stay hidden, so mark anything sensitive `t3-secret`.
- A `themes/` folder of theme JSON files is published while the plugin is active, and an `assets/`
  folder is served to the web half when the plugin has one. T3 Code remembers the published
  themes, so the boot screen and the desktop window start in the active theme's colors. A theme
  that sets `"sidebarArtwork": true` keeps the nightly and dev artwork in the sidebar, which T3
  otherwise swaps for a label; the send button stays plain. `"radius"`, such as `"0.625rem"`, sets
  T3's corner radius, and `success`, `successForeground`, `info` and `infoForeground` in a theme's
  `colors` or `variants` set its status colors.
- A `styles/` folder of `.css` files is added to the page while the plugin is active, in name
  order, after T3's own styles and the theme. A manifest and `styles/` are a whole plugin, with
  no `server` or `web`, as in the `styles-plugin` fixture. Like a web half, styles and themes load
  only from the environments turned on under **Load plugin UI from** in Settings → Plugins, which
  starts with just the main environment.
  **Reload** picks up edits. The page gets each file's text, so a `url()` can't reach the
  plugin's folder; use a `data:` URL for an image.

## Server half

```js
/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.rpc.register("greeting", () => "Hello", { access: "read" });
  },
};
```

`activate` receives the [`PluginApi`](./src/server.ts): settings, storage, RPC methods and channels
for the web half, and MCP tools for agents. `api.settings.get()` reads from memory after its first
call, so a handler can call it on every request.

Everything a plugin registers is released when it is disabled, reloaded or uninstalled; add your
own cleanup with `api.onDeactivate`.

`rpc.register` takes an `access`. Any session that can read the environment may call a `read`
method, a guest's read-only session included. A `write` method needs the `orchestration:operate`
scope, which the owner's sessions have and a read-only session lacks. The handler's second argument
has the caller's `access` and a `signal`. The signal aborts when the caller goes away, the plugin
stops, or 30 seconds pass, and a method that hasn't answered by then fails. A client can send any
JSON as input, so check it before acting on it.

`rpc.publish` sends a value to every session that follows the channel, and any session that can read
the environment may follow one, so never publish secrets. A subscriber gets only the values
published after it subscribes, so give the web half a method that returns the current value and call
it after subscribing, as [`examples/quick-notes`](./examples/quick-notes) does with `list`. A
subscriber that falls behind keeps the latest 64 values of each channel and loses older ones. A
method's result and a published value can each be at most 256 KB as JSON, because one large
WebSocket message holds up everything else on the connection. A bigger result fails the call, and
`publish` throws.

A promise rejection in plugin code that nothing handles, such as in a timer, doesn't stop T3 Code.
It shows on the plugin's row in Settings → Plugins, and the plugin keeps running. An exception
nothing catches does stop the server. When T3 Code can tell it was your plugin's, the plugin stays
off after the restart until the user turns it on again. That includes a throw in a timer callback
and an `'error'` event with no listener, so catch errors in callbacks and give every child process,
socket and stream you create an `'error'` listener.

## Tools for agents

`api.mcp.registerTool(tool, handler)` gives agents a tool, as
[`fixtures/mcp-plugin`](./fixtures/mcp-plugin) does.

- Agents see the tool as `plg_<id>_<name>`. `name` uses letters, digits, `_` and `-`, and the
  whole name must fit in 64 characters, because MCP clients refuse longer ones.
- `access` is `read` or `write`. Any agent can call a `read` tool. A `write` tool runs only for an
  agent in a thread set to Full access and not in Plan mode, or an outside agent approved with Full
  access. Other agents, and agents from linked environments, get a refusal. Make every tool that
  changes something `write`.
- `inputSchema` is a JSON Schema with `"type": "object"` and no `anyOf`, `oneOf` or `allOf` at its
  top level, which model APIs refuse. Put alternatives inside a property. An agent can send any
  JSON object, so check the input before acting on it.
- The handler's second argument has a `signal`, which aborts when the agent cancels the call or the
  plugin stops, and the `threadId` of the calling agent's thread, or `null` for an MCP client
  outside a thread. It returns JSON, and a throw becomes an error the agent reads. A call that
  hasn't answered within 5 minutes fails the same way, and its `signal` aborts.
- Every agent in every thread of the environment sees the tools of every plugin that is on, so
  each tool takes up room in every agent's context. A plugin registers at most 32 tools, each with
  a description of up to 1,000 characters and an input schema of up to 4,000 characters as JSON,
  and its tools' names, descriptions and schemas together take at most 24,000 characters.
  `registerTool` throws when a tool breaks a rule, so a plugin that registers it in `activate` fails
  to start and says why.

The server API can't read T3's threads, projects or providers. A tool can keep its own data per
thread in `storage` under the `threadId`, but it can't look that thread up.

## Web half

```tsx
import { Button } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

export default defineWebPlugin({
  activate(api) {
    api.rightPanel.register({
      name: "hello",
      title: "Hello",
      component: () => <Button onClick={() => api.navigate("/settings/plugins")}>Settings</Button>,
    });
    api.commands.register({
      id: "say-hello",
      title: "Say hello",
      run: () => api.toast({ title: "Hello" }),
    });
  },
});
```

`activate` receives the [`WebPluginApi`](./src/web.ts): calls into the server half, right panels, a
settings panel, palette and keybinding commands, redrawn parts, styles, assets, navigation and
toasts.

`api.rpc.invoke` and `api.rpc.subscribe` reach the methods and channels the server half adds with
`rpc.register` and `rpc.publish`. Describe them once as a `PluginRpcMap` type from
`@t3tools/plugin-sdk/shared`, and pass it to both `definePlugin` and `defineWebPlugin`. Then a
wrong method name, input or value fails to typecheck in either half.
[`examples/quick-notes`](./examples/quick-notes) keeps its map in `rpc.ts`.

The app can load web halves from several environments at once. Right panels show only in the threads
of the environment the plugin runs on, which `api.environmentId` names. When your plugin is on in
several of them, its commands, `injectStyles`, `ui.replace` and `composer.setCollapseOnScroll` take
effect from only the first, the main one when it's on there.

Register right panels inside `activate`. When the app restores a panel that was open, the panel
shows that the plugin is loading until `activate` finishes, then "Plugin not active" until a panel
with its name is registered.

`api.ui.replace(part, component)` draws one of T3's own parts your way: the composer's control row
(`composer.controls`), the frame Settings and Usage open in (`app.pageFrame`) and the sidebar
(`app.sidebar`). The component receives T3's own controls as ready-made pieces to arrange, plus
`original`, T3's own drawing of the part; `WebPluginParts` lists them. If your component throws, T3
draws its own part. Only 1 plugin draws a part: the one whose id sorts first, and the others' rows
in Settings → Plugins say so. T3 may add pieces to a part but never removes or merges one. A change
that has to renames the part, and T3 then skips replacements of the old name, with a note on your
plugin's row, and draws its own part. `api.composer.setCollapseOnScroll(true)` folds the composer
to one line on wide screens while the timeline is scrolled up, as it does on phones. Both arrived
in API version 2. [`examples/settings-pages`](./examples/settings-pages) shows Settings in place of
the thread (`app.pageFrame`'s `page`) and lists its sections in the sidebar, with Back at the
bottom (`app.sidebar`'s `nav` and `back`).

Build it with the Vite preset, which makes the bundle use T3 Code's own React, atoms, atom hooks and
UI components instead of shipping copies:

```ts
// vite.config.ts
import { t3PluginWeb } from "@t3tools/plugin-sdk/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [t3PluginWeb({ entry: "web.tsx", outDir: "dist" })] });
```

Point the manifest's `web` at `dist/web.js`.

Make atoms with `import * as Atom from "@t3tools/plugin-sdk/atom"` and read them with the hooks in
`@t3tools/plugin-sdk/atom-react`, such as `useAtomValue`. Both run T3's own copies, so your atoms
live in T3's registry and the bundle has no effect in it. Their types belong to the SDK, so they
don't change when T3 upgrades effect. Atoms from `effect` itself or hooks from `@effect/atom-react`
would bundle a second copy. [`examples/quick-notes`](./examples/quick-notes) keeps its notes in an
atom.

## Keeping a plugin working across T3 updates

T3 changes its markup, class names, labels and layout in most releases. You don't need to drop
parts of your design to survive that. Build each part on the most stable thing T3 offers for it:

- **Arrange pieces instead of rebuilding T3's controls.** `ui.replace` gives you T3's own controls,
  already wired up. Place them, wrap them or leave them out. A copied control, with its markup,
  icons and labels, misses every fix T3 makes to the real one.
- **Style with theme tokens.** A theme file in `themes/` sets T3's colors and corner radius. In your
  own components, use the CSS variables that `THEME_TOKENS` from `@t3tools/plugin-sdk/web` lists,
  such as `var(--border)` and `var(--radius)`, instead of hex or rgb values. T3 defines each of
  them under every theme and keeps them across releases.
- **Scope CSS to a region.** T3 keeps the `data-t3-region` names of the window's main areas
  across releases: `sidebar`, `main` (everything beside the sidebar), `timeline`, `composer`,
  `thread-details`, `right-panel`, `terminal`, `home`, `pull-requests`, `settings`,
  `settings-nav` and `command-palette`. A plain `background` rule recolors most regions, such as
  `[data-t3-region="composer"] { background: #101820; }`. The surfaces inside `main`,
  `right-panel` and `pull-requests` paint over them, so set `--background` on those three instead.
  For `terminal`, set `--terminal-background`, which a terminal reads when it opens. `terminal` is
  the drawer under the chat. A terminal opened in the right panel has no `terminal` region, so set
  `--terminal-background` on `right-panel` to reach it.
- **Reach into T3's markup only as a last resort.** Selectors on `aria-label`, `data-slot`, class
  names such as `[class~="border-border/65"]` or `.lucide-shield-off`, and `:has()` break when T3
  renames or moves things. Use one only when no theme value or region does the job. Keep each rule
  small and in one commented place, prefer one that falls back to T3's own look when the markup
  changes, and list it in the plugin's README with the seam that would replace it.
- **Leave T3's frame to T3.** The title bar row, the room for the window buttons on Windows and
  Linux, drag areas, phone safe areas and breakpoints are T3's, so don't resize or pad them. A page
  shown through `app.pageFrame` gets T3's header with all of that.
- **Compare ids, not text.** `app.sidebar`'s `page` and `app.pageFrame`'s `kind` are stable ids;
  labels such as `Settings` can change.
- **Check `api.version` before using a newer API member.** The server half and the web half each
  have their own `api.version`, which counts that half's additions. A member added after version 1
  names the version that added it in its doc, so a plugin can skip that feature on an older T3 and
  keep running. To require a T3 release instead, set `engines.t3`.
- **Ship what the plugin runs.** Installing a folder leaves out `.git` and `node_modules`, so
  build everything into the files the manifest names.
- **Ask for a seam.** When T3 doesn't hand over what you need, ask for a region, token, piece or
  part on the T3 Code repository instead of reaching into its markup.

## Developing a plugin

In Settings → Plugins, choose **Add plugin**, open **Link a plugin folder** and enter the plugin's
folder path. Then turn the plugin on on its row, and use **Reload** after each change. The path is
on the environment's machine. Linking adds the folder to `devPaths` in `plugins.json`, and
**Unlink** on its row removes it and leaves the folder alone. Linking refuses a folder whose id is
already listed, so remove the installed copy first.

To install a finished plugin, drag its folder onto Settings → Plugins, or use **Add plugin** to
choose it. Unlink a linked copy first. It installs turned off, so turn it on on its row.

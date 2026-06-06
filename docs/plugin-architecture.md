# Plugin Architecture

T3 plugins are trusted, local feature packages. A plugin owns its feature slice: server commands,
runtime logic, browser UI, dependencies, and plugin-local schemas. The host owns discovery,
activation, persistence, WebSocket RPC, static asset serving, and the stable SDK exposed through
`@t3tools/plugin-api`.

This architecture is intentionally not a browser extension model or an untrusted sandbox. Plugins run
as same-process server modules and authenticated browser bundles. Install only plugins that are
trusted to run with the same local authority as the T3 server.

## Shape

```text
$T3CODE_HOME/
  plugins/
    t3.automations/
      package.json
      src/manifest.json
      src/server/index.ts
      dist/client.iife.js

packages/plugin-api/
  src/server.ts
  src/ui.ts
  src/schema.ts
  src/package.ts

packages/plugins/automations/
  src/client/
  src/server/
  src/shared/
```

Plugins are discovered from `<baseDir>/plugins`, where `baseDir` is the configured T3 home. In normal
runtime that is `$T3CODE_HOME` or `~/.t3`; in monorepo dev it can be the dev home used by the server.
The dev helper `pnpm run plugins:install-dev` builds known local plugin packages and symlinks them
into `$T3CODE_HOME/plugins`.

## Dependency Boundary

Plugin packages should import T3 host APIs only from `@t3tools/plugin-api` subpaths:

| Need                 | Import from                    |
| -------------------- | ------------------------------ |
| Server plugin SDK    | `@t3tools/plugin-api/server`   |
| Browser plugin SDK   | `@t3tools/plugin-api/ui`       |
| Manifest/package SDK | `@t3tools/plugin-api/manifest` |
| Package metadata SDK | `@t3tools/plugin-api/package`  |
| Shared host schemas  | `@t3tools/plugin-api/schema`   |

Plugin packages should treat `plugin-api` as their only T3 SDK dependency. If a plugin needs more
host surface area, extend `plugin-api` first instead of importing from another T3 package.

Plugin-owned command payloads, document schemas, and feature models belong inside the plugin package,
usually in `src/shared/schema.ts`. This keeps feature-specific models out of core and lets a plugin
carry its own dependencies.

## Package Metadata

Each plugin package has a `t3Plugin` block in `package.json`:

```json
{
  "name": "@t3tools/plugin-automations",
  "version": "0.0.24",
  "t3Plugin": {
    "id": "t3.automations",
    "apiVersion": "^0.0.24",
    "manifest": "./src/manifest.json",
    "server": "./src/server/index.ts",
    "client": "./dist/client.iife.js"
  }
}
```

The package resolver validates this metadata, validates the manifest, rejects paths that escape the
package root, checks API compatibility, imports the server entry, and verifies that every declared
plugin id matches. A server entry must export a `ServerPlugin` as `default`, `plugin`, or
`serverPlugin`.

## Server Lifecycle

The server plugin host runs during server startup:

1. `PluginPackageResolver` scans `<baseDir>/plugins`.
2. Each package's `package.json`, manifest, server entry, and client asset path are validated.
3. `PluginHost` creates a per-plugin Effect scope.
4. The host builds a `PluginActivationContext` for that plugin id.
5. The plugin registers document collections, commands, placement badge providers, and runtime fibers.
6. `PluginRegistry` records the plugin as active or failed.

Plugin activation failures do not crash the server. Failed plugins stay in the catalog with
diagnostics so the UI can surface the problem.

A plugin activation context exposes:

- `store`: core-owned, plugin-namespaced JSON document storage with schemas registered at runtime.
- `commands`: server-target command registration with input/output schema validation. Client-target
  commands are UI actions that may opt into keybindings but are not server RPC handlers.
- `ui`: badge provider registration for plugin UI placements.
- `runtime`: host runtime actions, currently `createAndSendThread`.
- `events`: plugin event publication for catalog refreshes and subscriptions.

## Data Ownership

The host persists plugin documents in `plugin_documents` and namespaces every row by `plugin_id`.
Plugins still own their feature data model: they register collection schemas during activation and
the store validates all reads and writes through those schemas.

The Automations plugin currently registers:

| Collection | Owner       | Purpose                      |
| ---------- | ----------- | ---------------------------- |
| `rules`    | Automations | Scheduled prompt definitions |
| `runs`     | Automations | Recent execution history     |

Automations keeps next-run schedule state embedded in each rule document so rule edits and schedule
state advance through a single persisted rule write. Cron parsing and scheduling policy remain
Automations-specific; the host provides persistence and runtime primitives, not a generic scheduler
service.

## RPC And Events

The WebSocket surface has three generic plugin methods:

| Method              | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `plugins.list`      | Return plugin catalog, status, UI placements, assets |
| `plugins.invoke`    | Invoke a registered plugin command                   |
| `plugins.subscribe` | Stream plugin-published subscription events          |

The host registry validates command input and output schemas around every invocation. Plugins publish
events through `ctx.events.publish`; the registry adds `pluginId` and `createdAt`. The browser
subscribes and refreshes the catalog when plugin events arrive.

## Browser Lifecycle

The web app loads active plugin bundles from authenticated server routes:

```text
/plugins/assets/{pluginId}/client.js
```

The browser bundle is an IIFE. It registers routes through the global host:

```ts
import { registerPluginUi } from "@t3tools/plugin-api/ui";

registerPluginUi(window.T3PluginHost, "t3.automations", () => ({
  routes: {
    main: ({ ctx }) => <AutomationsPage ctx={ctx} />,
  },
}));
```

The browser host injects:

- React through `ctx.react`.
- Host UI primitives through `ctx.components` on route and composer render contexts.
- Command invocation through `ctx.api.invoke`.
- Navigation and thread-link helpers through `ctx.navigation` and `ctx.host`.
- Toast and confirmation helpers.

Plugins should use `ctx.components` instead of importing from `apps/web`. This keeps plugin bundles
self-contained while preserving the app's visual system and interaction behavior.

## UI Contributions

Plugin manifests contribute routes, fixed UI placements, and command metadata. Routes declare which
host surface they render into:

```json
{
  "routes": [{ "id": "main", "label": "Automations", "surface": "app" }],
  "ui": {
    "placements": [
      {
        "id": "main-sidebar",
        "position": "sidebar.primary",
        "label": "Automations",
        "routeId": "main",
        "order": 100
      }
    ]
  }
}
```

The first web UI placement positions are:

| Position                 | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `sidebar.primary`        | Main application sidebar entries above Projects |
| `sidebar.footer`         | Global utility entries near Settings            |
| `settings.sidebar`       | Plugin-owned Settings sections                  |
| `commandPalette.actions` | Route-opening command palette actions           |

The web app maps active app placements to:

```text
/plugins/$pluginId
/plugins/$pluginId/$routeId
```

Settings placements route to:

```text
/settings/plugins/$pluginId
/settings/plugins/$pluginId/$routeId
```

The default route id is `main`. Route rendering waits until the catalog and browser bundle are
available, then calls the registered route component with the plugin UI context.

## Automations Reference Plugin

Automations is the reference package for the expected plugin shell:

```text
src/
  manifest.json
  shared/
    constants.ts
    schema.ts
  client/
    index.tsx
    AutomationsPage.tsx
    useAutomationsController.ts
    domain.ts
    layout.ts
    types.ts
    components/
  server/
    index.ts
    plugin.ts
    commands.ts
    runtime.ts
    schedule.ts
    constants.ts
    errors.ts
    ids.ts
    runs.ts
    time.ts
  server.test.ts
```

The split is intentional:

- `shared/` contains plugin-local constants and schemas used by server and browser code.
- `client/` contains the browser registration, route composition, state controller, and
  presentational slices.
- `server/plugin.ts` wires manifest activation and host registrations.
- `server/commands.ts` owns command handlers.
- `server/runtime.ts` owns execution, overlap policy, retention, and schedule ticks.
- `server/schedule.ts` owns cron parsing and timezone validation.

Use Automations as the best-practice template for new plugins.

## Current Limits

- Plugins are local and trusted; there is no sandboxing or permission prompt model.
- Plugin installation is file-system based; there is no marketplace or remote installer.
- Code reload requires a server restart.
- Connector plugins are future work.
- Plugin-owned dependencies are supported at package level, but the server imports plugin server code
  into the same Node process.

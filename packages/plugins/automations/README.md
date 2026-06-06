# Automations Plugin

Automations is the reference package for a self-contained T3 plugin. It keeps plugin-only
dependencies, server runtime code, browser UI, and shared plugin constants inside the plugin
package.

See [Plugin Architecture](../../../docs/plugin-architecture.md) for the host/plugin boundary,
discovery model, package contract, and runtime lifecycle.

## Package Shell

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
      FilterBar.tsx
      RuleDialog.tsx
      RulesSection.tsx
      RunsSection.tsx
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

## Conventions

- `src/client/index.tsx` is the browser entrypoint. It should only register routes through
  `window.T3PluginHost`.
- `src/client/AutomationsPage.tsx` composes the route with host UI components.
- `src/client/useAutomationsController.ts` owns route-level state, RPC calls, and mutations.
- `src/client/components/` contains focused presentational slices that consume `ctx.components`.
- `src/client/domain.ts` contains small pure client helpers.
- `src/shared/` contains plugin-local constants and schemas used by both client and server. Do not
  move these into core unless the concept is truly cross-plugin.
- `src/server/index.ts` is the server entrypoint declared in `package.json`.
- `src/server/plugin.ts` wires the manifest, collection schemas, runtime startup, badges, and
  command registration.
- `src/server/commands.ts` owns RPC command handlers.
- `src/server/runtime.ts` owns rule execution, overlap handling, retention, and schedule ticks.
- `src/server/schedule.ts` owns cron parsing, timezone validation, and schedule helpers.

Plugins should import host UI through `ctx.components`, not from `apps/web`. This keeps plugin UI
self-contained while still inheriting the web app's visual system.

Plugin code should import T3 host primitives only from `@t3tools/plugin-api` subpaths. If a plugin
needs more host surface area, extend `plugin-api` first instead of importing from another T3 package.
Plugin-owned command payloads and document schemas belong in the plugin's own `src/shared/schema.ts`.

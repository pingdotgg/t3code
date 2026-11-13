---
name: t3-extension-development
description: Use when creating, modifying, debugging, packaging, or testing a T3 Code extension or its custom UI, tools, commands, hooks, or settings.
---

# T3 extension development

Before creating or modifying extension code, read the [complete extension developer guide](references/api.md). Use its TypeScript starter, manifest reference, panel bridge examples, Settings-page and theme guidance, packaging checks, and troubleshooting sections for the part you are changing.

Extensions execute trusted code in an unsandboxed Node process on the owning T3 server. A mobile or remote client controls that process through the existing connection. Resolve paths, dependencies, and credentials on the server.

Read the installed SDK types and the project's extension files before changing them. Keep `apiVersion: 1` in `t3-extension.json`. Export a default object with `activate(context)` from the manifest's `main` module. Published packages must ship executable JavaScript, their manifest, and self-contained HTML panels. Use `@t3tools/extension-sdk` for types and `defineExtension`.

Declare commands and tools in the manifest and register exactly those ids during activation. Tool arguments and optional command arguments use JSON Schema. Return JSON values. Keep commands useful to both clients and agents. `extensions_list` returns contribution schemas; `extensions_invoke` invokes a named command or tool on its owning environment.

Use `context.callT3` for environment-local services: `projects.list`, `threads.list`, `threads.get` with `{threadId}`, `orchestration.dispatch` with a T3 command, `settings.get`, and `settings.update`. Mutations use the same service paths as clients. The extension's filesystem, network, and subprocess access is unrestricted.

Declare specific event names in the manifest's `events` list and use `context.onEvent` for committed project and orchestration events. Events are live notifications, not a durable job queue. Await work inside handlers, handle failures, and make external effects idempotent where needed. Use `context.onSettingsChanged` for settings changes and `context.onDispose` to release resources. Store persistent extension data in `context.storagePath`.

For custom UI, ship a self-contained HTML document and declare a panel. T3 injects `window.t3Extension` before the panel's scripts. Call `window.t3Extension.call(commandId, input)` to run a command on the server; read `window.t3Extension.context` for invocation context. Use the injected CSS variables (`--background`, `--foreground`, `--primary`, `--border`, `--font-sans`) and `window.t3Extension.theme`; `onThemeChanged` reports live palette/light/dark changes without a reload. Read `window.t3Extension.settings`, save field patches with `updateSettings`, and subscribe with `onSettingsChanged`. Declare `settingsPages` with field keys and/or a panel id to add independent pages to the main Settings list on every client. Use responsive layouts and accessible controls. The same document runs in desktop/web frames and mobile WebViews. Never hardcode a localhost origin or run host code in the panel.

Install an absolute server-local folder with `extensions_install`, or use Settings > Extensions. Reload after source or manifest changes, inspect the reported status and server logs, and test the panel and its command through the actual client. Verify persistence by disabling/re-enabling and restarting the test server. Test an invalid input and activation failure. Use isolated T3 state for development.

T3 installs this skill and the linked guide automatically in its own state directory at server startup and refreshes them on later starts. `extensions_development` returns this skill's path and the guide's `referencePath`. The repository source of the guide is `docs/extensions.md`; `examples/extensions/host-notes` is an executable example. Do not replace or edit a user's existing provider skills or configuration to make an extension discoverable.

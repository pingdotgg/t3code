# Developing T3 Code extensions

Extensions add host functionality and UI to T3 Code. They run on the environment's server, including when a user controls a desktop-hosted server through T3 Connect, a browser, or mobile. Each enabled extension gets an unsandboxed Node process with the server account's filesystem, network, environment variables, and subprocess access. Install only trusted code. Process separation contains crashes; it is not a security boundary.

## Contents

- [Try the working example](#quick-start)
- [Build a TypeScript extension](#build-a-typescript-extension)
- [Manifest and package layout](#package-layout)
- [Host SDK and T3 services](#typescript-sdk)
- [Events and hooks](#events-and-hooks)
- [Custom UI and the panel bridge](#custom-ui)
- [Main Settings pages and themes](#settings-pages-and-themes)
- [Lifecycle, storage, and management](#lifecycle-storage-and-management)
- [Automatic development-skill installation](#automatic-development-skill-installation)
- [Development and verification](#development-and-verification)
- [Troubleshooting](#troubleshooting)

## Quick start

Open **Settings > Extensions**, select the owning environment, choose **Local folder**, and enter the absolute server-local path to `examples/extensions/host-notes` in this checkout. Install it and open its **Host notes** panel. Save a note, refresh, and read it from another connected client. The example also contributes a command, agent tool, status item, committed-event hook, and persistent setting.

Agents can use `extensions_install` with `{sourceType: "local", source: "/absolute/path"}`. `extensions_list` returns installed manifests, status, settings, and tool schemas. `extensions_invoke` accepts `{id, kind: "command" | "tool", name, input, context?}`. Every operation targets one environment. Agents creating or modifying extensions should load the automatically advertised `t3-extension-development` skill with `extensions_development`.

## Build a TypeScript extension

The following steps create a small extension with a command, agent tool, Settings page, and panel. Run these commands in your extension project. They are independent of the T3 repository's build tooling.

```sh
mkdir t3-example
cd t3-example
npm init -y
npm install @t3tools/extension-sdk
npm install --save-dev typescript @types/node
```

When developing against an unreleased T3 checkout, build the SDK with `vp run --filter @t3tools/extension-sdk build`, run `npm pack` in `packages/extension-sdk`, and install the resulting tarball in your extension project instead of the registry package. Use the SDK matching the server API you are targeting.

Set these fields in your extension's `package.json`, keeping the dependencies npm added:

```json
{
  "name": "acme-t3-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "files": ["dist", "panel.html", "t3-extension.json"],
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
```

Keep `private: true` while experimenting. Remove it deliberately when publishing your own package. The package name used by npm and the extension's manifest id serve different purposes; the examples use `acme-t3-example` and `acme.example` respectively.

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

Your source tree will be:

```text
t3-example/
  package.json
  tsconfig.json
  t3-extension.json
  panel.html
  src/
    extension.ts
```

Use the manifest in the next section, the host module under [TypeScript SDK](#typescript-sdk) as `src/extension.ts`, and the document under [Complete panel example](#complete-panel-example) as `panel.html`. Then:

```sh
npm run build
```

In **Settings > Extensions**, choose **Local folder** and install this project's absolute path on the owning T3 server. T3 reads `dist/extension.js`, activates the host, and exposes the declared contributions. Open the extension's **Example** Settings page, change Greeting, and run Say hello. The same value is available through the panel and the agent tool.

After editing TypeScript, rebuild before choosing **reload**. After changing the manifest or panel document, reload so the server reads those files and clients receive the new process generation. Local folders are loaded from their original location; they are not copied into T3's package storage.

## Package layout

An extension directory contains `t3-extension.json`, an executable module, and any panel documents or dependencies. An npm extension is a normal npm package with this layout at its root. `main` and panel `entry` paths resolve against that root. Install dependencies and compile TypeScript before installing a local extension. npm installation executes normal package lifecycle scripts on the host. T3 downloads a pinned Node/npm distribution into its own state directory, verifies its SHA-256 against the checksums shipped with T3, and caches the validated installation. Host Node/npm are not prerequisites. Lifecycle scripts receive the managed Node directory on PATH. Every extension, including a local folder, runs under this managed Node runtime. Standard `process.execPath`, `child_process.fork`, and Node subprocess arguments work in packaged T3 installations. The first activation needs access to nodejs.org; npm installations also need the configured registry. Later activations reuse the runtime. T3 does not change global Node or npm configuration.

```json
{
  "id": "acme.example",
  "name": "Example",
  "description": "An example extension",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "dist/extension.js",
  "commands": [
    {
      "id": "greet",
      "title": "Say hello",
      "description": "Return a greeting",
      "menu": "thread",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    }
  ],
  "tools": [
    {
      "id": "greet",
      "description": "Return this host's greeting",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    }
  ],
  "panels": [{ "id": "main", "title": "Example", "entry": "panel.html" }],
  "settingsPages": [
    { "id": "example", "title": "Example", "settings": ["greeting"], "panelId": "main" }
  ],
  "events": ["thread.created"],
  "statusItems": [{ "id": "greeting", "text": "Greet", "command": "greet" }],
  "settings": {
    "greeting": {
      "title": "Greeting",
      "description": "Text to return",
      "type": "string",
      "default": "Hello"
    }
  }
}
```

Extension ids and contribution ids use lowercase letters, digits, hyphens, and dot-separated names, beginning each segment with a letter. Extension ids are unique per environment; contribution ids are unique within their kind. Command and tool ids may match. Versions use `major.minor.patch` with an optional prerelease suffix. API version 1 is the compatibility contract; incompatible versions are rejected before executing code.

Commands have a title, description, optional JSON Schema for arguments, and an optional `thread` or `project` menu location. Tools require a description and argument schema. Arguments are validated before a handler runs. Register exactly the command and tool ids in the manifest; mismatches fail activation. Status items reference an existing command. Settings support strings, finite numbers, and booleans, with matching defaults. Unknown setting keys and values of the wrong type are rejected.

### Manifest reference

| Field                 | Required | Authoring guidance                                                                                      |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `id`                  | Yes      | Stable identity within an environment. Changing it creates a different extension and storage namespace. |
| `name`, `description` | Yes      | Human-facing identity and purpose.                                                                      |
| `version`             | Yes      | Extension version, independent of the SDK package version.                                              |
| `apiVersion`          | Yes      | Use `1`; unsupported API versions fail validation.                                                      |
| `main`                | Yes      | Executable host module, relative to the extension root.                                                 |
| `commands`            | No       | User actions with optional argument schemas and contextual menu placement.                              |
| `tools`               | No       | Agent actions with JSON Schema arguments.                                                               |
| `panels`              | No       | Self-contained HTML documents.                                                                          |
| `settings`            | No       | Named string, number, or boolean fields and their defaults.                                             |
| `settingsPages`       | No       | Independent main Settings pages referencing fields and/or a panel.                                      |
| `events`              | No       | Exact committed-event or extension-event names to receive.                                              |
| `statusItems`         | No       | Text actions that invoke declared commands.                                                             |

An omitted contribution list contributes nothing. A manifest entry alone does not implement a command or tool: activation must register a handler with the same id. Panel ids referenced by Settings pages, setting keys referenced by pages, and command ids referenced by status items must exist in the same manifest.

## TypeScript SDK

Use `@t3tools/extension-sdk` for `defineExtension`, `ExtensionContext`, `InvocationContext`, and JSON types. Compile extension TypeScript to ESM JavaScript for distribution. Node does not strip TypeScript in installed `node_modules` packages.

```ts
import { defineExtension } from "@t3tools/extension-sdk";

export default defineExtension({
  async activate(context) {
    const greet = () => ({ text: context.settings.greeting ?? "Hello" });
    context.registerCommand("greet", greet);
    context.registerTool("greet", greet);
    context.onEvent(async (event) => {
      if (event.type === "thread.created") console.log("A thread was created");
    });
    context.onSettingsChanged(async (settings) => {
      console.log("Greeting changed:", settings.greeting);
    });
    context.onDispose(async () => {
      // Release resources owned by this extension.
    });
  },
});
```

The SDK is versioned independently from T3 Code. `EXTENSION_API_VERSION` is the manifest API version supported by this SDK. The SDK does not bundle T3 services into the extension process. `callT3` uses a method-indexed input/result map generated from T3's service contracts, so the method determines both argument and return types. Published types are standalone and require no internal T3 packages. Dates in service calls are ISO 8601 strings; service codecs translate them at the IPC boundary.

### Context API

| Member                         | Behavior                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `extensionId`                  | Manifest id                                                                      |
| `storagePath`                  | Persistent server-local directory owned by this extension                        |
| `settings`                     | Current resolved values, replaced before settings listeners run                  |
| `registerCommand(id, handler)` | Registers a declared command                                                     |
| `registerTool(id, handler)`    | Registers a declared agent tool                                                  |
| `onEvent(handler)`             | Listens to event types declared in the manifest; returns an unsubscribe function |
| `onSettingsChanged(handler)`   | Listens to persisted settings changes; returns an unsubscribe function           |
| `onDispose(handler)`           | Registers cleanup, invoked in reverse registration order                         |
| `callT3(method, input)`        | Calls an environment-local service using the host's authority                    |
| `emit(type, data)`             | Emits an extension event for other subscribing extensions                        |

Command/tool handlers receive `(input, invocationContext)` and return a JSON value or a Promise of one. Invocation context can include `threadId`, `projectId`, and `surface` (`web`, `desktop`, `mobile`, or `agent`). Do not assume context is present for commands invoked from Settings. Agent tool calls use the actual calling thread when available. Treat explicit context as selection information, not an authorization credential.

### T3 service calls

| Method                   | Input                         | Result                    |
| ------------------------ | ----------------------------- | ------------------------- |
| `projects.list`          | `{}`                          | Project snapshot          |
| `threads.list`           | `{}`                          | Thread shell snapshot     |
| `threads.get`            | `{threadId}`                  | Thread snapshot           |
| `orchestration.dispatch` | A T3 `OrchestrationV2Command` | Committed command receipt |
| `settings.get`           | `{}`                          | Server settings           |
| `settings.update`        | A `ServerSettingsPatch`       | Updated server settings   |

Use command ids and timestamps required by T3's command contracts. A committed command receipt does not mean provider work has finished. Observe committed events to follow completion. Service calls preserve the same orchestration and persistence paths as clients; trusted extensions also have unrestricted direct Node runtime access.

### Example service integration

Read snapshots through the SDK instead of inventing HTTP URLs or accessing a different environment's database:

```ts
const projects = await context.callT3("projects.list", {});
const shells = await context.callT3("threads.list", {});

if (invocation.threadId) {
  const thread = await context.callT3("threads.get", {
    threadId: invocation.threadId,
  });
  console.log(thread.snapshotSequence);
}

console.log(projects.projects.length, shells.threads.length);
```

These statements belong inside an async handler receiving `invocation`. Method names determine the input and result types. The service is always local to the extension's server; it does not implicitly forward a thread id to another environment.

For a mutation, dispatch the canonical T3 command. For example, declare `pin-current-thread` in `commands`, then register this inside `activate`:

```ts
context.registerCommand("pin-current-thread", async (_input, invocation) => {
  if (!invocation.threadId) throw new Error("Open a thread before running this command.");
  return context.callT3("orchestration.dispatch", {
    type: "thread.pin",
    commandId: crypto.randomUUID(),
    threadId: invocation.threadId,
  });
});
```

Use a fresh command id for a new action. The returned sequence identifies committed state; asynchronous provider work may continue afterward. The generated `OrchestrationCommand` union describes supported command shapes, and TypeScript rejects missing or incorrect fields.

Handler input is JSON; the SDK does not infer a TypeScript argument interface from your manifest's JSON Schema. Narrow values in the handler or decode them with your chosen validator before using them. Return JSON-compatible data: convert dates to ISO strings and buffers to an explicit encoding; do not return class instances, streams, functions, or cyclic objects over IPC.

### Events and hooks

Declare specific event names in `events`, then register `onEvent`. Events contain `{type, data}`. Project events and orchestration events are delivered after commit. Consult `packages/contracts/src/applicationEvent.ts` and `orchestrationV2.ts` for payloads. Subscribe only to events you need: streaming text events can be frequent.

Notifications are live and are not replayed after extension/server restart. Delivery is best effort if a process stops or a handler fails. They cannot veto committed commands. Keep handlers short, handle errors, and use persistent storage and idempotency for external work that must survive a restart. Hooks never execute inside the orchestrator's decision or database transaction.

`context.emit("changed", data)` from `acme.example` delivers `{type: "extension.acme.example.changed", data}` to extensions that declare that exact event name. These events share the same FIFO delivery lane as committed events. Each running extension has a bounded backlog of 128 notifications or 2 MiB; overload drops incoming notifications and reports a diagnostic. Slow listeners cannot block other extensions or T3's event intake. Hooks start only after activation completes. Do not echo events recursively.

## Custom UI

Panels are self-contained HTML documents, including their scripts, styles, and other assets. Bundle external assets into the document or use absolute URLs appropriate for the client. Relative URLs resolve in the client and are not server file paths. T3 renders the document in a trusted web/desktop frame or a mobile WebView; host Node code stays on the server.

T3 injects `window.t3Extension` before panel scripts:

```js
const result = await window.t3Extension.call("greet", {});
document.querySelector("#result").textContent = result.text;
```

`window.t3Extension.context` contains selection and surface information. The SDK's `@t3tools/extension-sdk/panel` entry provides `getPanelBridge()` and TypeScript declarations. The bridge only needs the existing environment connection, so it works over local, remote, and T3 Connect connections without additional ports or origins. Use accessible HTML and responsive layouts. Render user data with text nodes.

### Complete panel example

This document works with the `greet` command and `greeting` setting in the manifest above. It needs no framework or separate development server:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Example</title>
    <style>
      :root {
        font: 16px var(--font-sans, system-ui);
        color: var(--foreground);
        background: var(--background);
      }
      body {
        margin: 0;
        padding: 20px;
      }
      button {
        font: inherit;
        padding: 10px 16px;
        color: var(--primary-foreground);
        background: var(--primary);
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      button:focus-visible {
        outline: 2px solid var(--ring);
        outline-offset: 3px;
      }
    </style>
  </head>
  <body>
    <button id="greet" type="button">Say hello</button>
    <p id="result" role="status"></p>
    <script>
      const bridge = window.t3Extension;
      const button = document.getElementById("greet");
      const result = document.getElementById("result");
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const greeting = await bridge.call("greet", {});
          result.textContent = greeting.text;
        } catch (error) {
          result.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      const unsubscribe = bridge.onSettingsChanged((settings) => {
        result.textContent = String(settings.greeting);
      });
      window.addEventListener("pagehide", unsubscribe, { once: true });
    </script>
  </body>
</html>
```

The panel calls commands belonging to its own extension. It does not call host SDK services directly; add a command handler for that work. A tool is invoked by agents through `extensions_invoke` with `kind: "tool"`. A panel command uses `kind: "command"` internally.

The host injects the bridge before your scripts run. A panel's requests and responses are scoped to its mounted document. Closing or reloading the panel ends that document's response waiters; host commands already accepted can still complete. Unsubscribe listeners on page teardown when your UI owns other resources.

For a framework-based panel, bundle JavaScript, CSS, images, and fonts into the final document, or use absolute asset URLs reachable from every intended client. A relative `src="./dist/panel.js"` points at a client location and does not serve that file from your extension folder. Browser/WebView code cannot directly import Node filesystem APIs; put filesystem work in a host command.

### Panel bridge reference

| Member                        | Use                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `call(commandId, input)`      | Invoke a declared host command and receive a JSON result. Pass `{}` for an empty object schema.      |
| `context`                     | Read the available selection and client surface. Settings pages may have no selected thread/project. |
| `theme`                       | Read the current appearance and CSS variable map.                                                    |
| `onThemeChanged(listener)`    | React to live appearance or palette updates; returns an unsubscribe function.                        |
| `settings`                    | Read the current committed extension settings.                                                       |
| `updateSettings(patch)`       | Persist named setting fields and return the resulting values.                                        |
| `onSettingsChanged(listener)` | Receive committed updates, including updates from other clients.                                     |

A React, Vue, or other UI can import `getPanelBridge` from `@t3tools/extension-sdk/panel` in its build. Bundle that code into the panel rather than leaving an unresolved bare package import in the document.

### Settings pages and themes

An extension can add its own pages directly to the main Settings list alongside General, Appearance, and Chat. Declare `settingsPages` entries with `id`, `title`, optional `description`, optional `settings` field keys, and an optional `panelId`. Field keys render native T3 controls; a panel supplies arbitrary custom UI on the same page. References are validated before activation. Pages target the selected owning environment, appear in Settings search, and disappear when the extension is disabled or uninstalled. Web/desktop keyboard navigation and mobile Settings navigation include them.

For example, this creates a native Greeting field and a custom panel on one page:

```json
{
  "settingsPages": [
    {
      "id": "example",
      "title": "Example",
      "description": "Configure this server's greeting.",
      "settings": ["greeting"],
      "panelId": "main"
    }
  ]
}
```

Declare additional entries for additional pages. A fields-only page omits `panelId`; a panel-only page omits `settings`. Pages appear under Installed extensions in the main Settings navigation. This API adds independent pages; it does not insert fields into the built-in General, Appearance, or Chat page bodies.

Extension settings are environment-local values, shared by clients of that environment. The project/environment filter selects the owning environment but does not create per-project extension values. If your extension needs project-specific data, store it under `storagePath` keyed by project id and expose it through commands and custom UI.

Panels receive the client's current theme before their scripts execute. Style with CSS variables such as `--background`, `--foreground`, `--card`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--border`, `--ring`, `--font-sans`, and `--font-mono`. `window.t3Extension.theme` contains `{appearance: "light" | "dark", variables}`. `onThemeChanged(listener)` returns an unsubscribe function. T3 applies updated variables and `color-scheme` to the existing document when the client changes its light/dark mode or palette. This includes custom desktop/web palettes and mobile's native theme adapter. Panel form state survives theme updates. Extension authors choose how to style their own HTML; hardcoded colors will still be hardcoded.

`window.t3Extension.settings` contains committed extension settings. `updateSettings({greeting: "Hi"})` saves a patch on the server and returns the resulting settings; unspecified fields remain unchanged. `onSettingsChanged(listener)` receives updates from any connected client and returns an unsubscribe function. The native field controls also save patches and avoid writing a stale value merely because an unchanged editor lost focus.

A panel can save just one field without resending an old snapshot:

```js
await window.t3Extension.updateSettings({ greeting: "Welcome" });
```

Use the current `settings` getter or `onSettingsChanged` for display. Keep a user's unsaved local draft separate from committed values. Avoid saving an unchanged field merely because it lost focus. Richer settings such as lists, secret references, or structured documents need a custom panel and host storage/commands; native manifest fields remain primitive.

Panels are trusted UI and have no extension-specific sandbox. Browser and WebView platform behavior still applies. Keep credentials and host-only logic in the extension process.

## Lifecycle, storage, and management

Management supports install, update, enable, disable, reload, and uninstall from clients and MCP. An npm source is a package name with an optional version or tag. Updates resolve that source again; pin a version to keep it fixed. Local updates reload the source folder. Reload re-reads the manifest and starts a fresh process, which avoids module caching issues.

The registry and settings persist under the environment's state directory in `extensions/`. Extension data lives in `extensions/storage/<id>`. Disabling stops the process and removes its running contributions. Enabling or server restart activates it again. Uninstall unregisters the extension and stops it; local source and persistent data survive. Install the same id again to reuse that data.

A crashed extension is marked failed; other extensions and T3 continue. Reload after fixing the extension. Activation and shutdown have deadlines; unresponsive subprocesses are terminated. The host owns ordinary helper processes with POSIX process groups or a Windows job, including after a crash. Trusted code can explicitly detach/break away and then owns that lifetime itself. Ordinary calls have a response deadline. A timed-out event hook fails and stops its extension, dropping queued notifications until reload; asynchronous work from that hook cannot overlap later delivery. Nested T3 service requests have a 30-second deadline and are cancelled when their owning invocation times out or the extension stops. Cleanup callbacks are best effort; do not depend on them for crash recovery. Failed npm activation restores the prior registration and working package. Action and schema errors appear in the invoking client. Activation and overload diagnostics appear in management, and extension stdout/stderr goes to the server logs.

Existing environment authentication applies to clients invoking or managing trusted code. These checks protect access to the host; extensions do not have a restricted capability model or a permission manifest.

## Automatic development-skill installation

Every T3 server installs its bundled `t3-extension-development` skill automatically during startup, including servers launched by the desktop application. It does not require an extension to be installed first or an agent to call an installation command. The server refreshes the files from its shipped copy on later starts, so updates include the matching API guide.

The installed files are local to the owning environment:

```text
<T3 home>/userdata/skills/t3-extension-development/
  SKILL.md
  references/
    api.md
```

Agents in T3 receive an availability description explaining when the skill applies. When creating, changing, debugging, packaging, or testing an extension, they load it with `extensions_development`. That tool returns the installed skill's `path`, `content`, and the full developer guide's `referencePath`. The skill links to `references/api.md`, which the agent reads before choosing APIs. This works without a repository checkout or a network documentation request. Remote and mobile users trigger the same server-local discovery.

In this repository, `.agents/skills/t3-extension-development/SKILL.md` follows the usual skill layout and links to `references/api.md`. Its YAML `description` states when to use it. The bundled and repository copies are checked against this guide. Automatic installation is scoped to T3's own state; it does not modify global provider skill folders or their configuration. A provider's separate skill picker may therefore differ from the guidance T3 makes available through its instructions and MCP tools.

When asking an agent to build an extension, a useful starting request is: “Create a T3 Code extension for this task. Load the installed extension-development skill and its API reference, then use the existing connection for desktop and mobile UI.”

## Development and verification

Use a local folder and isolated T3 development state. Install the example, run a command from Settings and the command palette, and open its panel on web/desktop and mobile. Verify settings persist, disabled contributions disappear, bad arguments are rejected, a crash is reported, and reload recovers. Exercise a remote/T3 Connect connection without baking a localhost URL into the panel.

Run `vp run check:changed` before a contribution. The extension host tests exercise real subprocesses, persistence, lifecycle transitions, and failure recovery. A published extension should ship executable JavaScript, its manifest, dependencies, and panel documents; inspect `npm pack --dry-run` before publication. A public marketplace is outside this API's scope.

### Packaging and release checks

Build before installing a local folder or publishing a package. T3 loads `main` and panel entries from the installed package; a TypeScript source tree without executable output will fail activation.

```sh
npm run build
npm pack --dry-run
npm pack
```

Inspect the file list. Include `t3-extension.json`, the emitted host module, self-contained panel HTML, and any runtime dependencies the host imports. Put runtime dependencies in `dependencies`; the SDK and compiler can stay in `devDependencies` when the SDK helper has been bundled or the SDK is imported only for types. If emitted JavaScript still imports `defineExtension` from the SDK, the SDK must be bundled or declared as a runtime dependency. Use explicit ESM package/module settings, as in the starter above.

For npm installation testing, use a package source accepted by management, such as `acme-t3-example@1.0.0` or a tag. The manager accepts registry package names and versions/tags, not tarball paths or Git URLs. Test an unpacked tarball with Local folder before publishing, then test the registry installation in an isolated environment. Local installation does not run `npm install`; install its dependencies yourself first. npm package installation runs normal lifecycle scripts with managed Node/npm on PATH.

If publishing, remove `private: true`, select the intended registry, inspect package contents, and publish using your normal release process. T3's public marketplace is a separate concern. Keep the manifest id stable so updates retain settings and storage.

### Suggested verification sequence

1. Install into isolated T3 state and check that status becomes `running` without diagnostics.
2. Invoke each command from Settings and its intended palette/menu/status entry. Test valid arguments, invalid arguments, and a handler error.
3. Ask an agent to list contributions and invoke the tool using its declared schema. Verify the returned result and visible errors.
4. Open each panel and Settings page on desktop/web and native mobile. Check keyboard/focus behavior, narrow layouts, and long content inside mobile WebViews.
5. Change a setting from one client and observe the other. Leave an unchanged editor focused, update it remotely, and verify that blur does not restore stale data.
6. Switch light/dark appearance and another palette while editing a panel. Verify readable colors and preserved drafts.
7. Exercise an event your extension declares. Check for unwanted historical work after server restart and for duplicate external effects.
8. Disable, enable, reload, and restart the owning server. Verify registrations, settings, stored data, and helper cleanup.
9. Test the remote connection modes you intend to support, including T3 Connect. Check that no asset URL assumes the viewer is on the host machine.
10. Test the packaged host and target operating systems. Ordinary helper processes using `process.execPath` and `fork` should use managed Node.

Automate meaningful host logic with your preferred test runner and a temporary storage directory. Supply a small `ExtensionContext` fixture for service calls, or exercise the real T3 extension host for IPC and lifecycle behavior. Do not point tests at your working T3 home or rely on sleeps to wait for a committed effect.

## Troubleshooting

| Symptom                                           | What to inspect                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Installation reports `invalid-manifest`           | Check JSON syntax, API version, id/version rules, referenced files, duplicate ids, setting defaults, and page/status references.      |
| Activation reports mismatched registrations       | Compare every declared command/tool id with the ids registered before `activate` resolves.                                            |
| Activation cannot find a module                   | Build host JavaScript, check `main`, package `files`, ESM settings, and installed runtime dependencies.                               |
| First activation cannot obtain Node               | Check the owning server's access to nodejs.org and its runtime-download diagnostic. Installing Node on the phone does not help.       |
| npm install/update fails                          | Read the bounded npm exit/stderr diagnostic and server logs. Check package name, version/tag, registry access, and lifecycle scripts. |
| An updated local extension still behaves the same | Rebuild TypeScript and reload the extension on its owning environment.                                                                |
| A command reports `invalid-input`                 | Match the declared JSON Schema. For object schemas, send an object rather than `null`.                                                |
| A page or command disappears                      | Check the selected environment and whether the extension is disabled, failed, uninstalled, or unsupported by that server version.     |
| HTML loads but scripts/styles do not              | Bundle assets into the HTML or replace relative asset URLs with suitable absolute URLs.                                               |
| A panel fails only remotely                       | Remove localhost assumptions and client filesystem paths; send host work through the bridge.                                          |
| A panel ignores themes                            | Replace fixed colors with injected CSS variables; inspect `theme` and `onThemeChanged`.                                               |
| Event delivery reports dropped notifications      | Narrow subscriptions and shorten handlers; move durable work to extension-owned storage/jobs.                                         |
| A hook timed out and the extension stopped        | Fix the hung handler, inspect logs, and reload. Queued notifications from the failed process are discarded.                           |
| An agent does not know the extension API          | Load `extensions_development`, read `referencePath`, and check that the connected server includes extension support.                  |

Management diagnostics describe activation and backlog problems. Host stdout/stderr is written to the owning T3 server logs with an extension id prefix. Command, tool, panel-bridge, and management failures carry a reason and bounded diagnostic to their caller. Include the manifest version, API version, host operating system, connection mode, and diagnostic when reporting a problem; keep credentials out of examples and logs.

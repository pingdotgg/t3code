# T3 Code extension SDK

Build trusted host extensions for T3 Code with TypeScript. Extensions run in their own unsandboxed Node process on the owning server and expose commands, agent tools, events, settings pages, status items, and HTML panels to desktop, web, and mobile clients.

Install `@t3tools/extension-sdk` in your extension project. Import `defineExtension` and the host types from the main entry. Import `getPanelBridge` and UI bridge types from `@t3tools/extension-sdk/panel`. Compile host TypeScript to JavaScript and bundle panel scripts and styles into a self-contained HTML document before packaging.

Declare `apiVersion: 1` in `t3-extension.json`. The SDK's method-indexed `callT3` types describe the public JSON service contract and do not depend on private T3 packages. The panel bridge provides live theme variables, settings, and command calls over T3's existing connection.

Read the [complete developer guide](https://github.com/pingdotgg/t3code/blob/main/docs/extensions.md) and [working example](https://github.com/pingdotgg/t3code/tree/main/examples/extensions/host-notes). T3 automatically installs and refreshes the `t3-extension-development` skill and its linked `references/api.md` guide at server startup. Agents discover its use through T3 and load it using `extensions_development`; no separate installation is required. The guide includes a TypeScript project setup, a complete HTML panel, main Settings pages, live themes, service-call examples, packaging checks, and troubleshooting.

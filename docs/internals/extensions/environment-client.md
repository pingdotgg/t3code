# Installed environment clients

The web client and Electron renderer load trusted installed packages from the environment's authenticated extensions HTTP API. Settings → Integrations → Environment extensions selects the environment, an environment-local package directory, allowed projects and the workspace text-read capability. Installation and update require explicit trust consent and an access-management session. Other operations remain server-authorized.

The thread header's Extensions menu opens compatible side-panel or bottom-dock views as durable SDK ViewRecords. The client injects its existing React identity and an installed-tool invocation binding. An installed package does not import app-private bindings or another React runtime. Calls capture their explicit view context, package hash and cancellation signal; the environment verifies grants and resolves filesystem scope.

Registration is keyed by environment and package ID. Two environments may install the same ID with different code and grants. Unchanged catalog refreshes retain their factories and views. Disable, remove, update and changed grants unload the old registration; late code imports and tool results cannot revive it. One broken module does not unload unrelated packages.

Catalogs refresh on connection changes and through Refresh extensions in Settings. There is no periodic polling or installation-event subscription in this version. A package changed from another client can remain visible until refresh; runtime generation and grant checks must reject obsolete tool calls immediately. Captured composer text remains readable conversation content after removal. A missing renderer uses its saved fallback.

Client code is fetched over the existing cookie/bearer/DPoP environment HTTP path and imported from a temporary Blob URL, revoked after import. The catalog hash is the full immutable package hash; the server binds delivery to that expected hash, and the client checks the response matches. This is trusted executable code, not a JavaScript sandbox. The package bound is 1 MiB total and individual JSON payloads remain 64 KiB.

Focused checks exercise authenticated transport, environment separation, unchanged registration retention, replacement, grant/context rejection, late import/result disposal, and explicit Settings consent. UI-control test doubles isolate Settings state; integrated web/Electron installation and real model delivery require separate client/server proof. React Native mobile does not load these React DOM client entries.

Installed client capability access uses injected host.invokeTool. Server ToolSession.invoke calls the granted environment capabilities. Surface.capabilities describe direct client SDK services, which this loader does not expose; declaring one produces the SDK unavailable fallback. The sample therefore declares surface capabilities as empty and workspace-read capability on its server tool. These are separate requirements, not interchangeable grants.

Async client-module evaluation has a 10-second deadline; one module with unsettled top-level await does not block later packages. Connection disposal cancels the wait. This cannot preempt synchronous trusted JavaScript. Each attempted registration owns cancellation independent of the plugin caller; failed validation, update, removal and disposal abort its outstanding tool HTTP requests.

# MCP Apps

The boundary is T3's `mcpApps.*` RPCs and the Mac panel's `mcp_connect` / `mcp_call` tools.
Provider-owned servers stay behind the provider process. No provider credential is read or
forwarded. There is no additional MCP client dependency.

| T3 behavior | Rust boundary | Proof |
| --- | --- | --- |
| `McpAppRequests.resolve`, `findTool`, `callTool`, `toolInfo`, `readResource` | `mcp_apps.rs`, `Session::mcp_app_request` | `mcp_apps_calls_only_the_source_session_and_stores_context_without_a_session`; Effect client calls |
| `McpAppRequests.updateModelContext`, `McpAppModelContext` | SQLite context rows, next turn's untrusted App context | same test: replacement, clearing, UTF-8 limit, stopped session, fork-only access, rollback filtering |
| `McpAppSnapshot.snapshot` | `EngineHost::snapshot_mcp_app`, attachment store | engine test captures before terminal; file test covers MIME, URI, CSP, blob, size; differential cases compare actual T3 snapshots |
| Claude runtime's `mcpApps` | SDK query calls, SDK host control requests | `mcp_apps_use_the_live_query_and_honor_permission_rules`; differential check compares the real SDK host request with T3's request |
| Codex runtime's `mcpApps` | existing app-server requests; unloaded-thread resume and retry | `mcp_apps_forward_through_the_existing_app_server` records stub requests |
| panel toolkit and `AgentPanelBroker` | `conn_mcp::panels`, two panel RPCs | broker lifecycle tests; `mcp_panel_tools_relay_to_the_mac_and_keep_caller_guards`; tool parity on both servers |

`mcp-apps-parity.mjs` runs as part of the existing MCP parity check. It executes T3's current
helpers and snapshot writer on the same inputs as the Rust runner. It also checks generated
cookie/theme scripts and malformed Claude permission rules. These checks need no real model
or MCP service. The helpers' initial characterization tests failed before implementation.

Preserved behavior: App calls never start a session or a model turn; a missing tool and a
model-only tool are both not callable; resource reads stay on the producing server; App
context can change after the provider stops; a source rollback does not erase a fork's context.

Differences for bounds: 256 context entries per conversation; at most 16,384 fork ancestors;
32 desktop subscriptions, 128 pending panel calls, 16 queued requests per subscriber, 1 MiB per
panel request. The SDK host caps pending replies at 1,024 and native App calls at 32 per
query; callback calls keep the SDK's own lifetime. Requests over those limits fail. Document capture waits at most 20 seconds
per session before falling back to a plain tool row. Codex captures run in the session's event
pump rather than T3's concurrent capture fibers. Snapshot writes finish before publishing.
Malformed base64 documents are skipped; T3's Buffer decoder accepts some malformed inputs.

Scope: Linux server, macOS and iOS clients. No Windows, Android or source-control host code
was added. The desktop tools require a connected Mac, as they do in T3; iOS App cards use the
four App RPCs. A physical Mac/iPhone pass and real-provider turns are not part of this proof.

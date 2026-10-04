# OpenCode provider

T3 Code integrates OpenCode through the provider driver, adapter, and runtime modules under
`apps/server/src/provider/`. Local health checks and inventory use bounded CLI commands; configured
external servers are contacted through the SDK.

## Sessions and events

- `OpenCodeAdapter.ts` owns resume, descendant-session approvals, interruption, and event projection.
- Assistant text is retained as compact, message-indexed state. Tool payloads and completed
  historical parts are not cached or rescanned.
- Full-access approval auto-replies are guarded by resolved-request IDs and apply to descendant
  sessions owned by the thread.
- Locally launched OpenCode servers belong to the backend's lifetime. A subprocess guard watches a
  backend-owned pipe and terminates the server's process tree when that pipe closes, including
  after abrupt backend death; normal scope closure also terminates the tree. Configured external
  servers remain externally managed.
- Local session startup requires the directory-scoped `t3-code` MCP registration to report
  `connected`. A failed or missing registration fails startup and closes the runtime rather than
  admitting a session without working T3 tools.
- Backend restarts invalidate in-memory MCP credentials. Interrupted executions stop instead of
  continuing with stale credentials; send a new turn to resume persisted conversation history
  with fresh credentials. Delegation mutations are never automatically replayed after an
  ambiguous failure.

## Models and agents

- Inventory-provided variants appear as the **Reasoning** selector.
- Models that omit variants receive the standard `low`, `medium`, `high`, and `xhigh` reasoning
  levels, with `medium` as the default for OpenAI/OpenCode models.
- T3 Code no longer exposes its legacy Plan interaction mode, so the OpenCode `plan` agent is
  removed from composer and text-generation selections. Other primary agents remain selectable.

## Current architecture

The fork already contains the structural equivalents of later upstream file moves:

- OpenCode Git text generation remains in
  `apps/server/src/git/Layers/OpenCodeTextGeneration.ts`.
- Provider-scoped MCP credentials and lifecycle are centralized in
  `apps/server/src/mcp/McpSessionRegistry.ts`; a second `McpProviderSession` module would duplicate
  that ownership.
- Provider-specific browser and collaboration instructions remain in their existing instruction
  modules rather than depending on the newer upstream text-generation framework.

These locations preserve the current Effect beta and provider architecture while carrying the
corresponding OpenCode behavior.

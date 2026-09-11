# Workspace MCP

`/mcp/workspace` is an environment-local external control surface. Its 11 tools wrap existing orchestration commands and projections. It is distinct from the provider-session preview toolkit at `/mcp`, and from the packaged desktop companion gateway. Do not add environment routing here: remote selection belongs to the gateway or to the client choosing the correct environment endpoint.

Workspace callers need orchestration read/operate scopes, or a loopback principal. The packaged gateway keeps its separate `environmentId` routing, lifecycle grant, and `confirmed: true` settlement requirement. Transport availability in ChatGPT Voice remains a platform constraint, independent of these tools.

Settlement uses `thread.settle` and `thread.unsettle`, not archive or delete. Pre-checks give useful conflicts; the decider remains authoritative if a turn starts or a request arrives between the read and dispatch. Reuse its queued-start policy so the two-minute adoption window does not drift. Dispatch completes projection before the handler reloads the shell; list, detail, and connected clients use ordinary projections and events.

Do not put settlement in the in-session preview toolkit. Its caller is the running agent, and settling that same thread would violate the active-session invariant. Deferred settlement and automatic interruption are outside this interface. Handoff never implies consent to settle the source thread.

Assistant instructions live beside the workspace toolkit in `SKILL.md`.

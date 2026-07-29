# Domain documentation

This repository is a multi-context monorepo.

## Current sources of truth

Before exploring a product area:

1. Read the glossary and operating model in the root `AGENTS.md`.
2. Read the matching entries in `docs/reference/encyclopedia.md`.
3. Read relevant architecture and provider documentation.
4. Read applicable ADRs when they exist.

The established terms include provider, client, environment, project, thread, turn, and T3 home. Use those terms consistently in specs, issues, tests, and product copy.

## Future context maps

When domain-modeling work creates context documents, the root `CONTEXT-MAP.md` will point to the relevant context. Expected contexts include:

- Web client
- Desktop client
- Mobile client
- Server and orchestration
- Provider runtime boundary
- Shared contracts
- Shared client runtime

Context documents and ADRs are created only when a real terminology or durable-decision need appears. Their absence does not block repository work.

## ADR conflicts

If proposed work conflicts with an existing ADR, name the conflict explicitly rather than silently replacing the prior decision.

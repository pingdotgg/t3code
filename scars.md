# Project scars index

Keep this file small and load the detailed scar only for the subsystem being changed.

## Universal invariants

- Preserve credentials, tokens, private prompts, and user data; redact them from logs, screenshots, exports, and reports.
- Keep destructive, external, merge, approval, and credentialed operations behind explicit authorization and recoverable boundaries.
- Preserve isolated state, workspace ownership, provider lifecycle, and ambiguous-outcome recovery.
- Validate the acceptance criteria and relevant behavior, report blockers plainly, and do not treat an unrelated passing command as proof.
- Ship the smallest diff that makes the behavior true: no restating comments, no tests for pass-through wiring a real-client pass already covers, one check per non-trivial branch.

## Subsystem index

The complete scar record is preserved in `.agents/references/scars/full.md`. Load the linked sections relevant to the changed behavior, including related subsystems for cross-cutting changes. Each heading bounds a section; there is no requirement to read the whole archive.

| Detailed section                                                                                                                  | Load when working on                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Browser access and initial navigation](.agents/references/scars/full.md#browser-access-and-initial-navigation)                   | Browser credentials, cookie profiles, initial UI navigation                               |
| [Package boundaries](.agents/references/scars/full.md#package-boundaries)                                                         | Contracts and shared-package exports                                                      |
| [Runtime lifecycle and projection foundations](.agents/references/scars/full.md#runtime-lifecycle-and-projection-foundations)     | Provider startup, reconciliation, migrations, activity pagination                         |
| [Desktop packaging and React state](.agents/references/scars/full.md#desktop-packaging-and-react-state)                           | Desktop builds, selectors, timeline references, shell/detail hydration                    |
| [Provider tools and workspace ownership](.agents/references/scars/full.md#provider-tools-and-workspace-ownership)                 | MCP, approvals, CLI discovery, child ancestry, workspace cleanup                          |
| [Delegation and handoff transactions](.agents/references/scars/full.md#delegation-and-handoff-transactions)                       | Nested-thread creation, batch recovery, worktree handoff                                  |
| [PR reviews and checkpoint provenance](.agents/references/scars/full.md#pr-reviews-and-checkpoint-provenance)                     | Review findings, PR ownership, diffs, revert/checkpoint history                           |
| [Release builds and mobile integration](.agents/references/scars/full.md#release-builds-and-mobile-integration)                   | Packaging, native builds, mobile delivery, Connect auth, service health                   |
| [Desktop browser surfaces](.agents/references/scars/full.md#desktop-browser-surfaces)                                             | Browser host lifetime, floating panels, zoom, guest input                                 |
| [Workflow concurrency and recovery](.agents/references/scars/full.md#workflow-concurrency-and-recovery)                           | Dispatch, child visibility, cleanup jobs, prewarming, archiving, Git subprocess budgeting |
| [Pairing and environment recovery](.agents/references/scars/full.md#pairing-and-environment-recovery)                             | Pairing, browser validation, revocation, Tailscale, mobile cleanup                        |
| [Streaming reconnects and workflow dispatch](.agents/references/scars/full.md#streaming-reconnects-and-workflow-dispatch)         | WebSocket reconnects, interrupts, queued workflows, durable diagnostics                   |
| [Mobile protocol compatibility](.agents/references/scars/full.md#mobile-protocol-compatibility)                                   | Legacy auth, RPC IDs, capability flags, ticket replay                                     |
| [Migration repairs](.agents/references/scars/full.md#migration-repairs)                                                           | Divergent SQLite migration ledgers                                                        |
| [Client state and completion](.agents/references/scars/full.md#client-state-and-completion)                                       | React drafts, subscriptions, unread state, completion notifications                       |
| [Projection performance and service composition](.agents/references/scars/full.md#projection-performance-and-service-composition) | Snapshot caps, replay cursors, attachment cleanup, service layers                         |
| [Test clocks and durable PR monitoring](.agents/references/scars/full.md#test-clocks-and-durable-pr-monitoring)                   | Effect test clocks, poll leases, pagination, review reconciliation                        |
| [Projection schemas and checkout reservations](.agents/references/scars/full.md#projection-schemas-and-checkout-reservations)     | SQL read/write seams, Git cleanliness, checkpoint exclusions                              |
| [Mobile capabilities and cross-platform tests](.agents/references/scars/full.md#mobile-capabilities-and-cross-platform-tests)     | Mobile mutations, capability promises, Windows and subprocess fixtures                    |
| [UI discovery and browser capture](.agents/references/scars/full.md#ui-discovery-and-browser-capture)                             | Thread search, shared skill discovery, native recording and visibility                    |
| [Checkpoint and snapshot atomicity](.agents/references/scars/full.md#checkpoint-and-snapshot-atomicity)                           | Completion queues, SQLite snapshot transactions, revert finalization                      |
| [MCP schemas and auth bootstrap](.agents/references/scars/full.md#mcp-schemas-and-auth-bootstrap)                                 | No-argument tool schemas, auth cache races                                                |
| [Mobile drafts and navigation](.agents/references/scars/full.md#mobile-drafts-and-navigation)                                     | Subchat draft ownership, iPad navigation, rejected-outbox recovery                        |

When a new hard-earned lesson is discovered, add it to `full.md` under the matching area and keep this index updated. Do not replace a detailed scar with a generic reminder.

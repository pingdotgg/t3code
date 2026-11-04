---
title: "How agent providers plug into T3 Code"
description: "Learn how T3 Code integrates ACP and native providers, reports capabilities, isolates accounts, and tests real agent behavior."
updated: 2026-11-04
sources:
  - label: "Provider integration requirements and registration"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/adding-a-provider.md"
  - label: "Provider constraints and protocol boundaries"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md"
  - label: "Native provider adapter contract"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/ProviderAdapter.ts"
  - label: "Contribution approval and evidence policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md"
faq:
  - question: "How do I add an agent provider to T3 Code?"
    answer: "T3 Code starts ACP agents as ACP Registry entries. Agents using other protocols need a native ProviderAdapterV2 integration, with registration, capabilities, documentation, and replay tests."
  - question: "Does every T3 Code provider need custom adapter code?"
    answer: "T3 Code uses the shared ACP adapter for standard ACP agents. A dedicated ACP driver is appropriate only when behavior extends beyond the spec."
  - question: "Can a T3 Code provider claim unsupported features?"
    answer: "T3 Code integrations must disable capabilities the provider lacks, including fork, rollback, steering, or subagent support. Orchestration uses those flags to choose supported behavior or fallbacks."
  - question: "What tests does a T3 Code provider integration need?"
    answer: "T3 Code requires replay fixtures recorded from the real provider and exercised through the real adapter, orchestrator, and projections. Gated live tests can supplement those replays."
---

T3 Code integrates agents through provider adapters that translate native protocols into shared operations and events. ACP agents start as registry entries, while other protocols need a native adapter implementing `ProviderAdapterV2`.

## Choose ACP registration or a native adapter

Start with the agent's protocol. The [integration guide on GitHub](https://github.com/pingdotgg/t3code/blob/main/docs/internals/adding-a-provider.md) defines two paths:

| Agent behavior                                   | Integration path                                          |
| ------------------------------------------------ | --------------------------------------------------------- |
| Follows the ACP specification                    | Use an ACP Registry entry with the shared adapter.        |
| Uses ACP with behavior outside the specification | Add a small dedicated driver over the shared ACP adapter. |
| Uses another protocol                            | Implement the native `ProviderAdapterV2` boundary.        |

Do not put agent-ID checks into the generic registry adapter. Provider-specific behavior belongs in the driver and adapter. Orchestration and clients use capabilities rather than driver names.

If you want to connect an existing compatible agent, read [the ACP setup guide](/learn/providers/acp-agents) first. That task differs from implementing a new native integration. For an upstream change, check [contribution approval requirements](/learn/open-source/contributing) before building it.

## Report the features the provider supports

Every flag in `OrchestrationV2ProviderCapabilities` must reflect real behavior. Disable native fork, rollback, steering, or subagent support when unavailable. Orchestration can then choose supported fallbacks, such as portable context handoff.

Permission modes need the same accuracy. Advertise only modes the provider enforces natively through `supportedRuntimeModes`. T3 Code must not imitate a missing permission mode by automatically answering approval requests.

If a stored mode is no longer offered, the server runs it as Supervised. Approval and question options must keep the provider's original option IDs. Each request needs a decline path that the provider honors.

Planning is another separate decision. Hide the plan toggle unless the provider's plan output becomes T3 Code's proposed-plan card. Read [permission modes](/learn/safety/permission-modes) for the user-facing distinction between permissions and interaction choices.

## Keep accounts and background checks isolated

A driver identifies the integration. An instance identifies a configured provider with its own account and lifecycle. Store session state, catalogs, and credentials at the instance boundary.

Remove inherited credentials the instance did not configure. Otherwise, two instances can silently use the same account or billing context. A status probe must not open a session that starts hooks, MCP servers, or a login flow. Reserve heavier probes for an explicit refresh.

Inject the thread's MCP server so the agent can access T3 Code tools. A turn must also survive when that server is unreachable. For updates, use only an installer that demonstrably owns the executable; otherwise keep the update manual.

## Register the provider in the right places

A provider normally lives in `packages/provider-<name>`. The internal guide uses Pi as the reference package. Some existing drivers still live under `apps/server/src/provider/Drivers` during migration.

Implement and register the integration in this order:

1. Define instance settings through the package's `./settings` export.
2. Export a browser-safe and React Native-safe client definition through `./client`.
3. Export the driver and adapter through `./server`, with test internals through `./testing`.
4. Register the driver in `builtInDrivers.ts`, status ordering, the model compatibility manifest, and default-model contracts.
5. Register the client definition for both web and mobile, including settings search terms.
6. Add a user guide, an installation-table entry, and documentation for any permission differences.

New providers are off by default. Server-side provider packages use `ProviderHost` to reach paths, settings, attachments, and credentials. They do not import implementation code from `apps/server`.

## Prove behavior with real replay fixtures

A successful first response does not establish a complete integration. Record real provider transcripts with a recorder under `apps/server/scripts`. Replay them through the actual adapter, orchestrator, and projections.

Cover supported scenarios such as multiple turns, queued work, immediate interruption, steering, resume, and tool approvals. Unit tests suit pure logic and failures a live provider cannot produce on demand. Handwritten protocol frames alone cannot prove what the provider emits.

Pay attention to timing. A setting may appear after session startup. Stop can arrive before the provider registers a prompt. Background work can outlive the turn that launched it. Each terminal path must settle outstanding tools, questions, approvals, and subagents.

Quota failures need a `usage_limit` classification, with a reset time when available. A default-model selection is a sentinel that resets the session choice, rather than a literal model identifier to send upstream.

## Next steps

- Read [the architecture guide](/learn/open-source/architecture) to understand the adapter boundary.
- Check [the upstream contribution policy](/learn/open-source/contributing) before proposing a new driver.
- Use [ACP setup](/learn/providers/acp-agents) when the existing registry path fits your agent.
- Return to the [open source overview](/learn/open-source) for the surrounding developer documentation.

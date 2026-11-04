---
title: "How T3 Code works"
description: "Trace T3 Code from client requests to server orchestration, provider adapters, and Git checkpoints, with a map of the source code."
updated: 2026-11-04
sources:
  - label: "Architecture and ownership boundaries"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md"
  - label: "Shared architecture terms"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/glossary.md"
  - label: "How it works and where code lives"
    url: "https://github.com/pingdotgg/t3code/blob/main/AGENTS.md"
  - label: "Provider constraints"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md"
faq:
  - question: "What is T3 Code's architecture?"
    answer: "T3 Code connects web, desktop, and mobile clients to a server through authenticated RPC. The server owns workspace execution, orchestration, provider processes, and checkpoints."
  - question: "Does T3 Code run agents on my phone?"
    answer: "T3 Code's mobile client controls a server environment. Provider processes, credentials, terminals, Git, and project files belong to that server's environment."
  - question: "What is a checkpoint in T3 Code?"
    answer: "T3 Code stores checkpoint workspace state in hidden Git refs without adding commits to your branch. Restoring files must also respect the provider's ability to roll back its conversation."
  - question: "Does an accepted T3 Code command mean the task finished?"
    answer: "T3 Code acknowledges a command after its intent commits. Provider execution and follow-up work such as checkpoints finish separately."
---

T3 Code connects web, desktop, and mobile clients to a server that owns the workspace and agent execution. Its orchestrator records commands as durable events, while provider adapters translate between T3 Code and each agent's protocol.

## Which machine owns the work?

An environment is one running T3 Code server together with its machine, credentials, filesystem access, and state. The client displays and controls that environment. A remote client's local files or accounts cannot stand in for the server's resources.

The desktop app bundles a server, but its renderer follows the same client boundary. Shared connection and domain logic lives in `packages/client-runtime`. Web and mobile supply their own interfaces and platform services around it.

That design explains [the control plane idea](/learn/concepts/control-plane-for-coding-agents): you can change the surface controlling the work while execution stays with its owning environment. The [architecture overview on GitHub](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) documents the exact boundaries.

## What happens after you send a request?

Clients send typed WebSocket requests across the RPC contract in `packages/contracts/src/rpc.ts`. The server checks authorization for the requested operation. Authenticating a socket does not authorize every method available through it.

A state-changing request then follows this sequence:

1. The server turns the request into an orchestration command.
2. The orchestrator processes commands in order and decides which events follow from the current state.
3. The event sink commits events, current-state views, a command receipt, and pending effects in one database transaction.
4. After the commit, subscribers receive events and an effect worker performs the recorded actions.
5. The worker sends the results back into orchestration as further commands.

An effect can start an agent turn or capture a checkpoint. Keeping it outside the decision and transaction separates recorded intent from work that can fail or finish later.

The command receipt makes retries idempotent. A repeated command can return its recorded result without repeating the accepted operation. An acknowledgement means the intent committed. It does not mean the agent finished writing files.

## How do clients recover their state?

Projections are persisted views of current state. They commit alongside the events that change them, so the displayed state cannot advance ahead of its recorded transaction.

The event log retains a limited replay window for reconnects and command retries, roughly a day. Older covered events are pruned, with specific retained exceptions. Projections therefore cannot be rebuilt from an unlimited history of events.

A reconnecting client that missed pruned events resumes from a snapshot. Subscriptions also limit the history sent to a client viewing one thread. These choices matter when investigating reconnect behavior or a large conversation's performance.

## Where do provider differences belong?

A provider is an agent runtime, such as Codex or Claude Code. Its adapter converts native protocol behavior into the operations and events orchestration understands.

Provider-specific rules stay at that boundary. Clients and orchestration use reported capabilities rather than scattering checks for provider names through the application. A configured provider instance owns its account and session state.

Read [how providers plug into T3 Code](/learn/open-source/adding-a-provider) before changing an integration. Supporting a turn is only one part of supporting permissions, cancellation, background work, and resume correctly.

## How do checkpoints relate to turn completion?

A provider ending its turn and T3 Code finishing follow-up work are separate milestones. A late checkpoint or diff must not extend the recorded provider duration or make the agent appear active.

Checkpoints save workspace state through hidden Git refs, without adding commits to the user's branch. A restore must coordinate the files with the provider's conversation. If the provider cannot roll back that conversation, T3 Code rejects the restore before changing files.

## Where should you start reading the source?

| You want to inspect                    | Start here                |
| -------------------------------------- | ------------------------- |
| Requests, execution, and checkpoints   | `apps/server`             |
| Browser interface                      | `apps/web`                |
| Electron shell around the web UI       | `apps/desktop`            |
| React Native interface                 | `apps/mobile`             |
| Shared web and mobile connection logic | `packages/client-runtime` |
| Shared schemas and RPC contracts       | `packages/contracts`      |
| Shared runtime utilities               | `packages/shared`         |

## Next steps

- Use [the source build guide](/learn/open-source/build-from-source) to run a development checkout.
- Read [contribution requirements](/learn/open-source/contributing) before proposing an architecture change.
- Inspect [third-party notices](/learn/open-source/third-party-licenses) for software included with the application.
- Return to the [open source overview](/learn/open-source) for the rest of this section.

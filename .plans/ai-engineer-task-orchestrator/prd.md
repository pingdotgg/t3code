# AI Engineer Task Intake MVP PRD

## Problem Statement

T3 Code has the raw ingredients for an internal AI Engineer: a coding-agent runtime, Worktrees, Threads, and a small Orchestrator. The current orchestration work is drifting toward a broad product surface: Workspace UI changes, GitHub PR lifecycle, Slack promotion flows, detailed status sync, and rich Team App narratives. That is too much for the first useful milestone.

The MVP should prove one narrow thing: external Intake Sources can ask the AI Engineer for repo-grounded work, the system creates one durable Task, starts one T3 coding runtime, and replies with simple back-and-forth comments. Slack and Linear are the first Intake Sources. Support email webhooks and other system events should fit the same boundary later without reshaping the module.

## Solution

Build a backend-only Task Intake MVP centered on a small deep module: `apps/orchestrator/src/taskIntake`. That module owns Intake Source behavior through Chat SDK where applicable, including incoming message normalization, dedupe, idempotent Task lookup/creation, simple reply selection, and outbound comments/messages.

All boundaries into and out of the module go through schema-only contracts in `packages/contracts`. Convex HTTP routes, platform adapters, and T3 runtime bridge code should pass typed contract payloads instead of reaching into each other's implementation details.

The MVP has no Workspace UI changes. The existing T3 UI remains thread-based. Task state exists for backend routing and auditability, not for a new sidebar.

## MVP User Stories

1. As a teammate, I can mention the AI Engineer in Slack with a clear repo-grounded request and receive an acknowledgement.
2. As a teammate, I can comment to the AI Engineer in Linear and receive an acknowledgement.
3. As a teammate, I can continue the same Slack thread or Linear issue/comment thread and have the message routed to the existing Task instead of creating a duplicate.
4. As an operator, I can see that each Slack or Linear conversation maps to one Task through a stable External Link.
5. As an operator, I can rely on the Orchestrator to create a T3 Worktree and Primary Thread for clear Tasks.
6. As a teammate, I receive simple comments when work is accepted, needs clarification, fails to start, or completes.
7. As a teammate, I do not receive streamed coding-agent chatter in Slack or Linear.
8. As an operator, I can reason about Slack and Linear through one shared Task Intake path rather than two separate bespoke flows.
9. As an engineer, I can test the integration module with contract-shaped inputs without running Slack, Linear, Convex, or T3.

## Implementation Decisions

- No Workspace UI changes in this MVP.
- No GitHub PR lifecycle in this MVP.
- No Intake Source streaming in this MVP.
- No autonomous supporting Threads in this MVP.
- No status sync loops beyond simple Task state transitions caused by runtime lifecycle.
- Linear behavior is simple back-and-forth comments. Assignment-first workflow is not required for the MVP.
- Slack behavior is simple mention/thread handling. Channel-to-project inference is not required.
- Project routing can be intentionally simple: use configured Linear routing when available, otherwise use a single configured default Project or ask for clarification.
- Chat SDK is the central integration abstraction for conversational Intake Sources such as Slack and Linear. Source-specific code should sit behind Chat SDK adapters or very thin adapter wrappers.
- `packages/contracts` owns schema-only Task Intake contracts.
- `apps/orchestrator/src/taskIntake` is the deep module. It owns intake policy and hides Chat SDK/source differences from Convex functions and HTTP routes.
- Convex owns Task records, External Links, Work Sessions, and Task Events.
- T3 Code owns Worktree, Thread, Coding Agent runtime, and full transcripts.
- Intake Sources receive selected simple updates only: accepted, needs input, start failed, completed, failed.

## Proposed Boundary

`packages/contracts` should define:

- `TaskIntakeSource`: `slack | linear | support_email | webhook`
- `TaskIntakeConversationRef`: stable source conversation identity
- `TaskIntakeMessage`: normalized inbound text, actor, conversation ref, message id, URL, and timestamp
- `TaskIntakeResolution`: create new Task, route to existing Task, ignore, or ask for clarification
- `TaskIntakeReply`: simple markdown/text reply
- `TaskIntakeDeliveryResult`: posted, skipped, or failed

`apps/orchestrator/src/taskIntake` should expose:

- `normalizeInboundMessage`
- `resolveTaskForMessage`
- `buildInitialTaskPrompt`
- `selectOutboundUpdate`
- `postOutboundMessage`

Convex HTTP routes should authenticate requests and delegate quickly. They should not decide product behavior.

## Acceptance Criteria

- Slack and Linear inbound events are normalized into the same contract shape.
- Repeated webhook deliveries do not create duplicate Tasks or duplicate acknowledgements.
- A Slack thread or Linear issue/comment thread maps to one Task through `taskExternalLinks`.
- Clear requests create a Task, materialize a T3 runtime, and post one acknowledgement.
- Follow-up messages in the same Intake Source conversation route to the existing Task.
- Ambiguous requests produce a simple clarification reply and do not start coding.
- Runtime completion/failure produces one simple Intake Source reply.
- Raw coding-agent stream/activity is not posted to Slack or Linear.
- Integration behavior is mostly tested through pure module tests using contract-shaped fixtures.
- `bun fmt`, `bun lint`, and `bun typecheck` pass before completion.

## Out of Scope

- Workspace Task tree or any new UI.
- GitHub PR creation/linking/lifecycle.
- Slack Conversation promotion UX beyond clear mention/thread handling.
- Linear status sync, assignment routing, or workflow-state automation.
- Streaming T3 output into Slack or Linear.
- Rich Task timeline rendering.
- Mute/unmute commands.
- Aside-message semantics.
- Multi-organization SaaS tenancy.
- Cloud sandbox support.
- Production deployment.

## Notes

- The existing Task-domain schema work is still useful, but the MVP should stop adding product surface area around it.
- The integration module should be boring and testable: contract in, decision out, platform reply through one boundary.
- Before implementing Chat SDK-specific code, verify the current Chat SDK docs/API rather than guessing adapter signatures.

# Plan: Add an Attention Inbox and Smart Notifications

## Summary

Add an `AttentionInbox` that turns open loops and deterministic signals into a ranked list of projects and threads that need user attention.

Notifications should be downstream of the inbox, not a separate ad-hoc system. Every alert should answer three questions:

- what changed
- why it matters now
- what the user should do next

## Goals

- rank projects by actionability, not alphabetically
- notify only when attention meaningfully changes
- keep the inbox server-authoritative
- support web toasts and desktop notifications from the same source object
- use models to improve wording and prioritization hints, not to replace deterministic state

This is especially important because the current unread / completion signaling in the sidebar is partly client-local state. The new inbox should survive hydration and reconnects without depending on browser-only visit markers.

## Non-Goals

- sending every event as a notification
- shipping email / SMS / mobile push in the first slice
- depending on a model call to decide whether an approval or session failure is real

## Core Object: `AttentionItem`

Suggested fields:

- `id`
- `projectId`
- `threadId?`
- `scope` (`project`, `thread`, `external`)
- `kind`
- `score`
- `urgency`
- `state` (`active`, `dismissed`, `snoozed`, `resolved`)
- `headline`
- `reason`
- `suggestedAction`
- `sourceAnchors[]`
- `dedupeKey`
- `createdAt`
- `updatedAt`
- `lastNotifiedAt?`
- `snoozedUntil?`

## Deterministic Signal Sources

### Existing in T3 Code

- pending approvals and pending user input
- session start failures / runtime errors
- interrupted turns with unresolved follow-up
- latest turn completed and unseen
- branch / PR state from git status
- worktree orphan cleanup candidates
- stale projects with unresolved open loops

### Future external adapters

- PR review comments
- CI failures / recoveries
- issue assignment / mention events
- deploy failures

## Smart Notification Rules

Only create or re-notify items when actionability changes.

High-value examples:

- a thread is blocked and waiting on human input
- a long-running agent finished a meaningful episode recap
- CI failed on an active branch
- a PR review arrived on the branch tied to an active thread
- a project has gone stale while open loops remain unresolved
- a project canon likely drifted and needs refresh

Low-value examples that should **not** notify by default:

- every tool call completion
- every assistant delta
- every git status refresh
- every recap regeneration

## Scoring Model

Start deterministic.

Example score inputs:

- base severity by `kind`
- recency bonus

- stale-age multiplier
- open-loop count multiplier
- “waiting on human” bonus
- active branch / active PR match bonus
- snooze penalty

Then optionally add a model-generated short explanation, but never let the model invent the score from scratch.

## Stale Review Jobs

Add scheduled review passes that promote neglected projects back into the inbox.

Recommended thresholds:

- `24h` — thread-level warm review
- `7d` — project-level stale review
- `30d` — cold-start brief refresh
- `90d` — deep reacquaintance review

Each scheduled job should:

- re-evaluate open loops
- refresh recap freshness state if needed
- add or update an `AttentionItem` only if there is a clear next action or unresolved risk

## Notification Channels

### In-app

- inbox cards
- compact badges in the sidebar
- toasts for immediate attention transitions

### Desktop

Add a desktop notification bridge in the Electron app for high-value events only.

Suggested additions:

- `apps/desktop/src/main.ts` — notification dispatch
- `apps/desktop/src/preload.ts` — optional acknowledge / focus bridge
- web app surfaces remain driven by the same inbox object

## Model Assistance

Use Codex by default, with Gemini API and Claude Code as optional backends, for:

- writing the one-line `reason`
- suggesting a `next best action`
- classifying recap refresh type (`hot`, `warm`, `cold`)
- collapsing multiple related signals into one human-readable alert

Do **not** use models for:

- detecting pending approvals
- deciding whether a session failed
- determining whether a PR exists or CI is failing

## Proposed Changes

### Contracts

Add attention schemas and ws endpoints:

- `packages/contracts/src/attention.ts`
- `packages/contracts/src/ws.ts` additions for inbox reads / state changes

### Persistence

Add projection repositories:

- `apps/server/src/persistence/Services/ProjectionAttentionInbox.ts`
- `apps/server/src/persistence/Services/ProjectionNotificationState.ts`

### Server services

Add:

- `apps/server/src/reentry/Services/AttentionScorer.ts`
- `apps/server/src/reentry/Services/AttentionInboxProjector.ts`
- `apps/server/src/reentry/Services/NotificationDispatcher.ts`
- `apps/server/src/reentry/Services/StaleReviewScheduler.ts`

### Web UI

Add:

- `apps/web/src/components/AttentionInbox.tsx`
- `apps/web/src/components/AttentionBadge.tsx`
- `apps/web/src/lib/attentionReactQuery.ts`

## Rollout

### Phase 1

- deterministic inbox items only
- web inbox + sidebar badges + toasts

### Phase 2

- stale review jobs
- desktop notifications

### Phase 3

- model-assisted alert wording
- grouped / deduped recap alerts

## Risks

- notification spam if re-scoring is too eager
- stale alerts if resolution detection lags
- user distrust if model-written reasons overstate certainty
- duplicated effort if inbox state diverges from the open-loop registry

## Recommendation

Make `AttentionInbox` the single source of truth, and make notifications a view over it. That keeps the system debuggable and makes “why did I get this alert?” answerable from stored state.

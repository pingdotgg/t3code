# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

PostHog engineers working through the self-driving reports PostHog's agents file against their own codebase. They arrive in two distinct phases: a fast triage pass over a queue of 10–30 reports, where most get archived or deferred and only a few survive; then a deliberate return to the two or three that earned it, where they read the evidence properly and usually start work. The two phases are different jobs and the product must serve both, with a clean seam between them.

Secondary audience: PostHog itself, as the recipient of this prototype's argument about what the desktop app should be.

## Product Purpose

An inbox for PostHog self-driving reports that can actually do the work. A report arrives with an agent's research, evidence, and proposed fix; the person reads it, rules on it, and — when the answer is yes — an agent implements it in a real git worktree on their machine and opens a pull request. Success is a report leaving the inbox with a decision attached, and the decision costing as little as it honestly can.

## Positioning

Report-centric and BYOS (bring your own subscription). The report is the primary object; the coding agent is a tool the report reaches for. This is a deliberate rejection of the existing PostHog desktop app's shape, which is a generic coding tool with reports bolted onto it. This prototype is being built to pitch as its replacement.

The mechanism a neighboring product cannot copy: PostHog Cloud's inbox can only talk about a report, and a generic coding agent has never heard of one. This runs the user's own provider subscriptions (Claude Code, Codex, Cursor, Grok, OpenCode) as local subprocesses against local checkouts, so the same screen that carries the argument can also carry out the verdict — worktree, branch, commits, PR — without the work leaving the machine or the person leaving the report.

## Operating Context

- Built on a fork of T3 Code: a Node WebSocket server wrapping provider CLIs, serving a React/Vite web client that Electron also wraps as the desktop app.
- Reports are proxied from PostHog's `/api/projects/:id/signals/reports/` by the server, which holds the personal API key so it never reaches a client.
- A report carries: a conventional-commit-shaped title; a markdown summary with a lede and `## Problem` / `## Impact` / `## Solution` slots; priority (P0–P4) with a dollar value and a written justification; an actionability judgment (`immediately_actionable`, `requires_human_input`, `not_actionable`) with its own justification; source signals (support tickets, error-tracking issues, scout findings) carrying real prose; code paths, commits with reasons, and bounded code excerpts; suggested reviewers with the commit evidence that named them; a repo selection; charts; and sometimes an implementation PR URL.
- Reports are opened, archived (`suppressed`), or restored (`potential`) straight through to PostHog. Read state is local to the client.
- Working a report means a git worktree on a `posthog/<id>` branch, a provider agent seeded with the report rendered as markdown, and a pull request that links back to the report.
- Engagement is one conversation per report with two presentations the user chooses between: docked beside the report, or expanded into the full workspace (terminal, diffs, PR panel). Same thread either way; the toggle runs both directions.

## Capabilities and Constraints

- Binding surfaces: **web and desktop only**. Desktop wraps the web client, so one responsive design covers both. Mobile (React Native) is explicitly out of scope for this work; T3 Code's all-surfaces rule does not bind here.
- Remote and tunnel connection modes remain real: the web client is served both locally via `npx t3` and from `app.t3.codes`, so nothing may assume a local origin or a local filesystem in the browser.
- Anything crossing the wire is typed in `packages/contracts` (Effect/Schema). The server is event-sourced; async flows emit typed receipts.
- The server currently proxies reports, artefacts, and set-state. It does **not** yet proxy the report's source signals (`/signals/reports/:id/signals/`) or resolve chart queries; both are confirmed in scope for this work.
- Snooze/defer is not yet expressible: the set-state RPC accepts only `suppressed`, `potential`, and `resolved`.
- Performance is a product commitment inherited from T3 Code and its ~200k users: no continuously repainting animation, no oversized WebSocket payloads, no lists that are expensive to render. Users notice a dropped frame.
- Terminology: **report**, **signal**, **artefact**, **evidence**, **verdict**, **reviewer** come from PostHog and must not be renamed. **Thread**, **turn**, **worktree**, **checkpoint**, **provider**, **environment** come from T3 Code and must not be renamed.

## Brand Commitments

PostHog's identity, already committed in code and binding: the warm PostHog palette in `apps/web/src/index.css`; RoundHog as the interface face (`apps/web/src/brand/fonts.ts`); the hedgehog illustrations used for empty, loading, and error states (`apps/web/src/brand/hoggies.ts`); and the status vocabulary in `apps/web/src/brand/statusColors.ts` — tangerine `#FF5C1C` reserved for what needs a person, amber for watching, green for done, red for failed, blue for links. The app is called **PostHog Inbox** in user-facing copy.

## Evidence on Hand

- Live report data via the PostHog API (project 2, `us.posthog.com`), including real summaries, artefacts, reviewers with commit evidence, and priority justifications with dollar values.
- Reference implementations to learn from, never to copy: `products/desktop/packages/ui/src/features/inbox` in the PostHog monorepo (the current desktop app), and `products/signals/frontend/inbox` (PostHog Cloud).
- No usage analytics for this fork, no user research, no testimonials. The two-phase session shape is the maintainer's own account of how he works and should be treated as a single informed report, not validated behavior.

## Product Principles

1. **The report is the object.** Everything else on screen — conversation, worktree, terminal, diff — is a tool the report reaches for. If a screen makes the report subordinate to the thread, it is wrong.
2. **The screen exists to get a decision.** Reading is in service of ruling. A layout that makes the evidence beautiful and the decision hard has failed at its only job.
3. **Show the work, but fold it.** The agent's research is the reason to trust the report; it is not the reading path. Every claim must be checkable, and no check may cost the reader who doesn't want it.
4. **Two phases, one object.** Triage and deep reading are different jobs over the same report. Neither may be implemented as a degraded version of the other.
5. **Reverse every door.** Archive needs restore, defer needs return, docked needs expanded, expanded needs docked. A one-way transition is a defect.

## Accessibility & Inclusion

Keyboard-first is a product requirement, not an accommodation: the inbox list is already driven by `j`/`k`/`Enter`/`e`, and the triage phase must stay fully operable without a pointer. Every interactive element ships visible keyboard focus. Motion respects `prefers-reduced-motion`.

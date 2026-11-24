# T3 Code Teams Fork

This directory documents the vision, technical specification, and phased roadmap for adding first-class **Team** support to T3 Code.

## Why this fork exists

Upstream [T3 Code](https://github.com/pingdotgg/t3code) is an exceptional Agentic Development Environment (ADE) for a single developer. Its remote-ready architecture makes it tempting to point an entire engineering team at a single shared `t3server`—and doing so immediately unlocks a powerful shared agentic workspace.

In practice, however, running upstream T3 Code as a shared team server breaks down quickly:

1. **No access boundaries.** Everyone connected to the server can see, modify, and post in every thread and run work on every environment.
2. **Manual thread attribution.** Members have to manually prefix their thread titles (e.g., `alice: fix auth`) just to tell who owns what.
3. **Notification overload.** Everyone gets notified for every thread on the shared server, making notifications unusable.
4. **Shared GitHub bot workaround.** Teams end up signing the shared server into a single shared GitHub account (e.g., `msl-agent`) and prompting agents to add `Co-authored-by` trailers manually—which is fragile, loses real per-user GitHub permissions/audit trails, and still risks one user acting under another's identity.

The goal of this fork is to turn T3 Code into a **first-class multi-user ADE for teams** while preserving what makes T3 Code great: speed, openness, remote-first execution, multi-surface support (desktop, web, mobile), and clean upstream mergeability.

## Core concepts

| Term | Meaning |
| --- | --- |
| **Team** | A named collaborative workspace owned and coordinated by a single remote `t3server` (the **Team Server**). |
| **Team Server (Default Team Environment)** | The remote `t3server` that owns the team's durable state (members, roles, views, team projects, team providers, linked environments, follow subscriptions). It is also the default execution environment for the team. |
| **Team Environment** | An execution environment attached to a team—either the default Team Server or an additional remote `t3server` linked by the Team Server. Access can be restricted by role or member whitelist. |
| **Member & Pseudo** | An authenticated user belonging to a team, identified internally by an immutable `memberId` and displayed everywhere by their chosen `pseudo` (e.g., `alice: refactor billing`). |
| **Role** | A hierarchical team permission level: `owner > admin > modo > regular`. Any role can assign its own role or any lower role. |
| **View** | A server-enforced visibility and posting policy attached to team threads. Defines who can **see** threads in the view and who can **post** in them (by role and/or member whitelist). |
| **Locked Thread** | A thread created or marked locked by an `owner` or `admin`. Only `owner` and `admin` members can post in a locked thread. |
| **Followed Thread** | A colleague's thread that a member explicitly subscribes to so they receive notifications for its activity. |
| **Per-Turn GitHub Forwarding** | Ephemeral injection of the *turn initiator's* GitHub credentials and git author identity into a shared environment for the duration of that turn only. |

## Documents in this folder

- **[architecture.md](./architecture.md)** — Full functional requirements, data model, authorization rules, provider routing, per-turn GitHub credential brokering, UI/UX design, and upstream merge strategy.
- **[roadmap.md](./roadmap.md)** — Phased implementation plan from core team identity through RBAC/views, UI/notifications, and per-turn GitHub forwarding.
- **[testing-e2e.md](./testing-e2e.md)** — Multi-member E2E testing architecture (1 Team Server + ≥2 isolated local apps, fake LLM proxy, fake Git/GitHub server).
- **[ci-and-releases.md](./ci-and-releases.md)** — Fork GitHub Actions CI & release pipeline (`teams-ci.yml`, `teams-release.yml`), signing secrets reference, and upstream tag hygiene.

# Teams Fork Roadmap

This roadmap breaks the [Teams Architecture & Technical Specification](./architecture.md) into incremental, shippable milestones. Each milestone delivers immediate value for a team sharing a `t3server` while strictly following our [Upstream Compatibility & Merge Strategy](./architecture.md#8-upstream-compatibility--merge-strategy) (sidecar `team_*` SQLite tables + independent `team_schema_migrations`, dedicated `team/` modules, thin upstream hooks, and `team.*` i18n keys) so `upstream/main` can be ported regularly with minimal conflict.

---

## Milestone 1 — Team Foundation, Member Identity & Pseudo Attribution

**Goal:** Replace anonymous shared-server access with named team members, deep-link onboarding, and automatic `pseudo:` thread attribution.

### Scope
- **Contracts (`packages/contracts/src/team/`):**
  - Schemas for `Team`, `TeamMember`, `TeamRole`, `TeamInvite`, and member-scoped auth responses.
- **Server (`apps/server/src/team/`):**
  - SQLite tables: `teams`, `team_members`, `team_invites`.
  - Bind `SessionStore` rows to `memberId` + `teamId`.
  - Invite creation & redemption endpoints (supporting prefilled `pseudo` and role).
  - Stamp `creatorMemberId` on thread creation and `authorMemberId` on every turn/prompt (server-authoritative).
- **Client runtime & UI (`packages/client-runtime`, `apps/web`, `apps/desktop`):**
  - **Settings → Teams:** create/link a team to a remote `t3server`, manage your pseudo, generate/copy invite links.
  - Deep-link handler (`t3code://team/join?...`) and hosted-web join flow with prefilled pseudo confirmation.
  - Render all team threads prefixed with `pseudo: <title>`.
  - Default sidebar filter hiding colleagues' threads + one-click toggle to show/hide colleagues' threads (also in command palette & keybindings).

### Definition of Done
- Two team members join the same remote `t3server` with distinct pseudos via deep link or Settings.
- Threads created by Alice automatically show as `alice: <title>` without manual renaming.
- By default, Alice sees only her own threads and can toggle to see Bob's threads.

---

## Milestone 2 — Notifications & Thread Following

**Goal:** Eliminate notification spam on shared team servers.

### Scope
- **Server:**
  - SQLite table `team_thread_follows (thread_id, member_id, created_at)`.
  - RPCs to follow/unfollow a thread and include `isFollowing` in thread/shell projections.
  - Gate server-side notification delivery (`NotificationMailbox.ts` and mobile push) to: thread creator, explicit followers, or the author of the completing turn.
- **Client (`apps/web`, `packages/client-runtime`):**
  - Update `threadNotifications.ts` so desktop/web notifications only fire for owned/followed threads.
  - Add **Follow / Unfollow** control in the thread header, sidebar context menu, and command palette.
  - Optional sidebar filter pill for "Followed threads".

### Definition of Done
- Bob running turns in his threads produces zero notifications for Alice.
- Alice clicks **Follow** on one of Bob's threads and receives notifications for that thread until she clicks **Unfollow**.

---

## Milestone 3 — RBAC, Views, Posting Rules & Thread Locking

**Goal:** Enforce real multi-user permissions on the Team Server.

### Scope
- **Roles (`owner > admin > modo > regular`):**
  - Role management UI in **Settings → Teams → Members**.
  - Server-enforced rule: member invites and role management start at `modo`; a member (`modo+`) can grant their own role or any lower role, cannot demote/modify higher roles, and cannot remove the last `owner`.
- **Views (`team_views`):**
  - Built-in **Default View** (readable and postable by all team members by default).
  - `owner`/`admin` CRUD UI for Views with separate **Read** and **Post** rules (by role and/or member whitelist).
  - `owner`/`admin`/`modo` ability to change a thread's View.
  - Any member with Read access to a View can create a thread in it, and a thread's creator can always post in their own *unlocked* thread.
  - Server-side filtering of `subscribeShell`, `subscribeThread`, `searchThreads`, and thread RPCs based on `canReadThread`.
  - Server-side enforcement of `canPostInThread` (viewing never implies posting); read-only composer state in UI when posting is disallowed.
- **Thread locking:**
  - `owner`/`admin` can create locked threads and lock/unlock existing threads.
  - Locked threads allow posting **only** by `owner` and `admin`.

### Definition of Done
- A `regular` member cannot see threads in an `admin`-only view (verified at both RPC and UI layers).
- A member with read-only access to a view can read threads and create their own thread, but cannot post in a colleague's thread.
- Locking a thread immediately blocks `modo` and `regular` members (including the creator) from posting.

---

## Milestone 4 — Team Projects, Remote Environments & Team Providers

**Goal:** Let teams share model providers and multiple execution environments seamlessly across local and remote machines.

### Scope
- **Team Projects:**
  - Assign a project to a Team during creation or in Project Settings.
  - New-thread environment picker on team projects: choose **local environment** or any **remote team environment** (including the default Team Server) permitted by the member's ACL.
  - Sync locally executed team-project threads (metadata + transcript updates) into the Team Server's thread list so colleagues can view them while tool calls remain executed on the local machine.
- **Team Environments & ACLs (`team_environments`):**
  - Team Server UI & RPCs to attach additional remote `t3server` environments.
  - Per-environment access rules (default: everyone on the team; configurable by role and/or member whitelist).
  - Server-enforced environment launch authorization.
- **Team Providers (`team_providers`):**
  - Configure model providers per team in Settings.
  - Authenticated **Team Model Proxy** on the Team Server so threads on team projects use team-configured providers whether running on the default Team Server, an attached remote environment, or a member's local environment—without leaking raw team API keys to local machines.
  - Clear UI capability indicator for CLI-subscription providers that can only execute on remote team environments.

### Definition of Done
- A project assigned to Team X lets Alice start a thread locally or on an attached GPU server, using Team X's configured providers in both cases.
- Restricting an environment to `admin` + Bob hides/blocks it for Alice.

---

## Milestone 5 — Per-Turn GitHub Identity Forwarding & Turn Isolation

**Goal:** Eliminate shared bot accounts (`msl-agent`) and manual commit co-signing on shared environments safely.

### Scope
- **Per-member GitHub credentials:**
  - Member GitHub connection in Settings (Phase 5a: encrypted fine-grained PAT per member; Phase 5b: GitHub OAuth / GitHub App user-to-server tokens).
  - Store `github_login`, `github_name`, `github_email` alongside encrypted credentials in `ServerSecretStore`.
- **Per-turn credential brokering:**
  - Local turn-scoped credential broker (`GIT_ASKPASS` + `gh` credential helper + per-turn `GIT_AUTHOR_*` / `GIT_COMMITTER_*`).
  - Short-lived single-turn credential lease for attached remote team environments.
  - Immediate credential revocation when a turn completes, fails, or is cancelled.
- **Cross-user turn isolation:**
  - Automatic provider session recycle (stop warm process & resume fresh) whenever `authorMemberId` changes between turns in the same thread.
  - Block mid-turn steering by other `regular`/`modo` users (allow queueing a next turn instead).
  - Restrict mid-turn intervention to `owner`/`admin`, with immediate revocation of the original user's active GitHub credential lease on intervention.

### Definition of Done
- Alice starts a thread on the shared server, asks the agent to commit and open a PR → commit author and PR author are **Alice**.
- Bob posts a follow-up turn in the same thread asking for another commit and push → commit author and push credentials are **Bob**, with zero access to Alice's token.
- While Alice's turn is running, Bob cannot steer it; an `admin` can interrupt/intervene without acting under Alice's GitHub credentials.

---

## Milestone 6 — Mobile Parity, Translations & Hardening

**Goal:** Bring full team support to every T3 Code surface and lock down edge cases.

### Scope
- **Mobile (`apps/mobile`):** Team switcher, deep-link join, pseudo prefixes, "My threads" default filter + toggle, follow/unfollow, View/Lock badges, and per-member push notification filtering.
- **Translations (`i18n`):** Add and verify all new UI strings via `vp run i18n:generate` and `vp run i18n:check`.
- **Testing & verification:**
  - Integration tests for RBAC, View filtering, thread locking, and per-turn GitHub isolation.
  - End-to-end scenarios (`vp run scenarios:prove`) covering multi-member collaboration.
  - Security audit of WebSocket subscription filtering, asset access, and credential lease revocation.

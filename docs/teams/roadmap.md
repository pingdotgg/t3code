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
  - Any member with Read access to a View can create a thread in it, and a thread's creator can always post in their own _unlocked_ thread.
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
  - Sync locally executed team-project threads (metadata + transcript updates) into the Team Server's thread list so colleagues can view them while tool calls remain executed strictly on the owner's local machine (never executable by other members, even `owner`/`admin`).
- **Inaccessible-Environment UX & Thread Notes (`team_thread_notes`):**
  - Greyed-out composer + localized banner when viewing a thread on an inaccessible environment (another member's local machine or a restricted remote environment), offering **`Fork this thread`** and **`Leave a note`**.
  - Inline Note Mode in composer creating immutable, hash-pinned **`Note from <pseudo>:`** timeline entries with owner notification.
  - Owner inline controls (**`Accept`**, **`Edit`**, **`Reject`**, 1-click **`Accept & Send`**), preserving `original_body` when edited by the owner, allowing **empty prompts** when ≥1 note is accepted, and requiring an explicit **UI confirmation dialog** when accepting or editing a note authored by a `regular` member (`modo`+ skip the confirmation modal).
  - Server-enforced explicit `acceptedNotes: [{ noteId, contentHash }]` turn dispatch + automatic timeline re-anchoring (`anchor_turn_id = newTurnId`) so a note arriving concurrently with a new prompt is ignored by the model and displayed after that turn; notes approved while a turn is already running enter the thread's queue with a **dashed style** and expose **`Send now`** strictly to the thread creator.
- **Team Environments & ACLs (`team_environments`):**
  - Team Server UI & RPCs to attach additional remote `t3server` environments.
  - Per-environment access rules (default: everyone on the team; configurable by role and/or member whitelist).
  - Server-enforced environment launch authorization.
- **Team Providers (`team_providers` — zero-config for teammates):**
  - Provider authentication and configuration performed **only by `owner`/`admin` on the Team Server**; teammates never sign in or configure team provider credentials locally.
  - Auto-provision isolated virtual local instances (`team:<teamId>:<providerInstanceId>`) with separate `GEMINI_HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR` from personal subscriptions; strictly restrict team projects to `team:<teamId>:*` (never fall back to personal providers).
  - Authenticated **Team Model Proxy** (`/api/team/provider-proxy/:id/*`) for API-key / `BASE_URL` providers (zero company keys leave the Team Server).
  - Authenticated **Ephemeral OAuth Token Lease** (`POST /api/team/provider-lease/:id`) for OAuth subscription harnesses (Antigravity/Gemini, Codex via `CodexManagedTokenBroker`, Claude OAuth): Team Server refreshes server-side, strips `refresh_token`, and leases only short-lived `access_token` + `expiry` to isolated local/remote instances (with proactive background renewal and `ProviderContinuationRequests` auto-resume for >1h turns).
  - Clear `remote-only` indicator for any CLI driver that cannot safely be proxied or leased without a `refresh_token`.
- **Agent Privilege Containment & Control-Plane Isolation:**
  - Bind every injected T3 MCP token on team threads to `actingMemberId = turnAuthorMemberId` (propagated immutably to subagents/delegates and rotated on author-switch session recycle) so agents cannot bypass RBAC, Views, thread locks, or Environment ACLs via MCP tools.
  - Add `--team-hub-only` (control-plane-only) server mode and deployment guide for splitting `t3hub` (owns `statev2.sqlite`, `ServerSecretStore`, and OAuth `refresh_token`s under `0700` OS permissions, never spawns agents) from `t3runner` (unprivileged OS user attached over loopback as the Default Team Environment).

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
- **Cross-user turn isolation & mid-turn queueing:**
  - Automatic provider session recycle (stop warm process & resume fresh) whenever `authorMemberId` changes between turns in the same thread.
  - Reuse upstream's native queued-run pipeline and UI (`apps/web/src/components/chat/QueuedRunsControl.tsx`) for messages posted by non-creators (and approved Notes) while a turn is running — dashed queued presentation, never auto-steered.
  - Gate **`Send now`** (`promote_to_steer` / `steerNext`) strictly to the **thread creator only** on both server and UI (not even `owner`/`admin`); `owner`/`admin` receive an explicit **`Interrupt`** action that stops the active turn and immediately revokes its GitHub credential lease.

### Definition of Done

- Alice starts a thread on the shared server, asks the agent to commit and open a PR → commit author and PR author are **Alice**.
- Bob posts a follow-up turn in the same thread asking for another commit and push → commit author and push credentials are **Bob**, with zero access to Alice's token.
- While Alice's turn is running, Bob's message enters the queue in dashed style and Bob cannot click `Send now`; only Alice (creator) can click `Send now`, while an `admin` has an explicit `Interrupt` button (no `Send now`) that revokes Alice's active GitHub lease.

---

## Milestone 6 — Mobile Parity, Translations & Hardening

**Goal:** Bring full team support to every T3 Code surface and lock down edge cases.

### Scope

- **Mobile (`apps/mobile`):** Team switcher, deep-link join, pseudo prefixes, "My threads" default filter + toggle, follow/unfollow, View/Lock badges, and per-member push notification filtering.
- **Translations (`i18n`):** Add and verify all new UI strings via `vp run i18n:generate` and `vp run i18n:check`.
- **Testing, Sandboxing & Hardening:**
  - Optional Linux per-turn `bwrap` (bubblewrap) worktree sandboxing on shared runners (bind-mounting only the thread's worktree + `/tmp` + turn broker socket) + `/proc` `hidepid=2` runbook.
  - Integration tests for RBAC, View filtering, thread locking, member-bound MCP enforcement, and per-turn GitHub isolation.
  - End-to-end scenarios (`vp run scenarios:prove`) covering multi-member collaboration.
  - Security audit of WebSocket subscription filtering, `t3hub`/`t3runner` OS boundary, asset access, and credential lease revocation.

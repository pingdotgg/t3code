# Teams Fork Roadmap

This roadmap breaks the [Teams Architecture & Technical Specification](./architecture.md) into incremental, shippable milestones. Each milestone delivers immediate value for a team sharing a `t3server` while strictly following our [Upstream Compatibility & Merge Strategy](./architecture.md#8-upstream-compatibility--merge-strategy) (sidecar `team_*` SQLite tables + independent `team_schema_migrations`, dedicated `team/` modules, thin upstream hooks, `team.*` i18n keys, and stable-release-only upstream syncs via `--no-tags`).

## Progress Overview

| Milestone            | Scope                                                                               | Status              |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| **Milestone 1**      | Team Foundation, Member Identity & Pseudo Attribution                               | Merged (PR #1)      |
| **Milestone 2**      | Notifications & Thread Following                                                    | Merged (PR #2)      |
| **Milestone 3**      | RBAC, Views, Posting Rules & Thread Locking                                         | Merged (PR #3)      |
| **Milestone 4**      | Agent Privilege Containment, Mid-Turn Queueing & Turn Interrupt Controls            | Merged (PR #4)      |
| **Milestone 5**      | Team Projects, Remote Environments, Local Sync & Thread Notes                       | Merged (PR #5)      |
| **Milestone 6**      | Zero-Config Team Providers, Team Skills & Pre-Prompts                               | Merged (PR #6)      |
| **Milestone 7**      | Per-Turn GitHub Identity Forwarding                                                 | Merged (PR #7)      |
| **Milestone 8**      | Team Scheduled Tasks (`(team, env)` Scoping & Team Automation Ownership)            | Merged (PR #10)     |
| **Milestone 9a**     | Server-Side Upstream Mobile Compatibility Layer (No Mobile Fork)                    | Merged (PR #8)      |
| **Milestone 9b**     | Optional Linux `bwrap` Worktree Sandboxing & `/proc` `hidepid=2` Runbook            | Merged (PR #9)      |
| **Post-M8 Polish**   | `modo` Interrupt + Queued-Msg Notif, Per-Team Sounds, `v0.1.13` + `harnessProfiles` | Merged (PR #11–#13) |
| **Phase 7b**         | GitHub OAuth / GitHub App User-to-Server Tokens & Device Flow                       | Merged (PR #14)     |
| **Audit Follow-ups** | Security/Multi-Env Hardening & Settings UX / Reverse States Polish                  | Merged (PR #15–#16) |
| **Post-Audit UX**    | Remove `displayName` (`scheduled: ` Prefix), Universal Follow & Per-Member Snooze   | Implemented         |

---

## Milestone 1 — Team Foundation, Member Identity & Pseudo Attribution _(Merged — PR #1)_

**Goal:** Replace anonymous shared-server access with named team members, deep-link onboarding, and automatic `pseudo:` thread attribution.

### Scope

- **Contracts (`packages/contracts/src/team/`):**
  - Schemas for `Team`, `TeamMember`, `TeamRole`, `TeamInvite`, and member-scoped auth responses.
- **Server (`apps/server/src/team/`):**
  - SQLite tables: `team_workspaces`, `team_members`, `team_invites`, `team_session_meta`, `team_thread_meta`, `team_turn_meta`.
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

## Milestone 2 — Notifications & Thread Following _(Merged — PR #2)_

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

## Milestone 3 — RBAC, Views, Posting Rules & Thread Locking _(Merged — PR #3)_

**Goal:** Enforce real multi-user permissions on the Team Server.

### Scope

- **Roles (`owner > admin > modo > regular`):**
  - Role management UI in **Settings → Teams → Members** with live session scope reconciliation and DPoP revocation on role/status changes.
  - Server-enforced rule: member invites and role management start at `modo`; a member (`modo+`) can grant their own role or any lower role, cannot demote/modify higher roles, and cannot remove the last `owner`.
- **Views (`team_views`):**
  - Built-in **Default View** (readable and postable by all team members by default).
  - `owner`/`admin` CRUD UI for Views with separate **Read** and **Post** rules (by role and/or member whitelist).
  - `owner`/`admin`/`modo` ability to change a thread's View.
  - Any member with Read access to a View can create a thread in it, and a thread's creator can always post in their own _unlocked_ thread.
  - Server-side filtering of `subscribeShell`, `subscribeThread`, `searchThreads`, turn diffs, assets, preview streams, terminals, devices, scheduled tasks, and thread RPCs based on `canReadThread`.
  - Server-side enforcement of `canPostInThread` (viewing never implies posting); read-only composer state in UI when posting is disallowed.
  - Parent-inherited team attribution for MCP-created child threads/delegates (`prepareThreadInheritedFromParent` / `recordThreadInheritedFromParent`).
- **Thread locking:**
  - `owner`/`admin` can create locked threads and lock/unlock existing threads.
  - Locked threads allow posting **only** by `owner` and `admin`.

> **Follow-up items added in post-M3 design discussions (carried into Milestone 4):**
>
> - Milestone 3 added parent-thread attribution inheritance for MCP-created child threads, but did **not** yet bind injected MCP tokens to `actingMemberId = turnAuthorMemberId` across all MCP tool handlers or introduce the `--team-hub-only` (`t3hub`/`t3runner`) OS-user split.
> - Milestone 3 tied `Interrupt` directly to `canPost` (so any non-creator with post access can currently interrupt another member's active turn) and did **not** yet enforce dashed mid-turn queueing, creator-only `Send now` (`promote_to_steer` / `steerNext`), or explicit `owner`/`admin`-only `Interrupt` on colleagues' running turns.

### Definition of Done

- A `regular` member cannot see threads in an `admin`-only view (verified at both RPC and UI layers).
- A member with read-only access to a view can read threads and create their own thread, but cannot post in a colleague's thread.
- Locking a thread immediately blocks `modo` and `regular` members (including the creator) from posting.

---

## Milestone 4 — Agent Privilege Containment, Mid-Turn Queueing & Turn Interrupt Controls _(Merged — PR #4)_

**Goal:** Close the remaining shared-server RBAC and multi-user turn-safety gaps so agents cannot exceed the triggering member's permissions and colleagues cannot hijack or prematurely interrupt an active turn.

### Scope

- **Plane 1 — Member-bound, turn-scoped MCP tool authorization:**
  - Bind every injected T3 MCP token (`OrchestratorMcpService.ts` / `McpToolAccess.ts`) on team threads to `actingMemberId = turnAuthorMemberId` (never a privileged server/admin token).
  - Propagate `actingMemberId` immutably to subagents, delegated tasks (`delegate_task`), and MCP-created child threads (narrowing only, never widening).
  - Enforce identical server-side team RBAC, View (`canReadThread` / `canPostInThread`), Lock, Queue (`Send now` creator-only), and Interrupt (`owner`/`admin` or active-turn/thread creator) checks across **every** MCP tool handler (`t3_thread_*`, `t3_project_*`, `t3_environment_*`, `t3_queue`, `delegate_task`, scheduled tasks, etc.).
  - Automatically recycle warm provider sessions (stop warm process & resume fresh) whenever `authorMemberId` changes between turns in the same thread, rotating the injected MCP token to the new `actingMemberId` (and laying the exact session-isolation foundation reused by Milestone 7's per-turn GitHub broker).
- **Plane 2 — Control Plane vs. Runner OS-user split (`--team-hub-only`):**
  - Add `--team-hub-only` server mode so `t3hub` runs strictly as the Team Control Plane (owns `statev2.sqlite`, `ServerSecretStore`, invites/RBAC, proxies, and brokers under `chmod 700 t3hub:t3hub`, and **never** spawns coding agents or shell terminals).
  - Support attaching an unprivileged loopback `t3runner` instance as the Default Team Environment, with zero OS filesystem access to `t3hub`'s data dir and no ability to mint sessions on `t3hub`.
  - Document the single-host `t3hub`/`t3runner` systemd/container deployment runbook in `docs/teams/` (or `docs/operations/`).
- **Mid-turn queueing, creator-only `Send now`, and explicit `owner`/`admin` `Interrupt`:**
  - Reuse upstream's native queued-run pipeline and UI (`apps/web/src/components/chat/QueuedRunsControl.tsx` + `ChatView.tsx`): any message posted by a **non-creator** while a turn is already running **never auto-steers** the active turn; it enters the thread's native queue with its existing **dashed border/style** (`en pointillé`) plus author pseudo attribution.
  - Gate **`Send now`** (`promote_to_steer` / `steerNext`) strictly to the **thread creator only** on both server (`ws.ts` + MCP `t3_queue`) and UI (`QueuedRunsControl.tsx`) — hidden and server-rejected for other colleagues **and** for `owner`/`admin` on someone else's thread.
  - Tighten Milestone 3's `Interrupt` authorization on both server (`ws.ts` + MCP `t3_thread_interrupt`) and UI (`ChatView.tsx`):
    - `regular` non-creators **cannot** interrupt another member's active turn (the composer shows queue-send behavior instead of an interrupt control for foreign turns).
    - `owner`, `admin`, and `modo` (extended to unlocked readable threads in PR #11) cannot click `Send now` on another member's thread, but receive an explicit **`Interrupt`** control to stop an ongoing turn cleanly (revoking any active turn's GitHub credential lease).
    - The thread creator (and active turn author) retains normal stop/interrupt control on their own turn.

### Definition of Done

- An agent triggered by a `regular` member on the Default Team Environment calling `t3_thread_list`, `t3_thread_read`, `t3_thread_send`, `t3_thread_interrupt`, `t3_queue`, or `delegate_task` is restricted to that member's exact RBAC/View/Lock permissions; subagents inherit `actingMemberId` immutably.
- Running `t3server --team-hub-only` refuses to spawn agents/terminals while serving the team control plane for an attached loopback `t3runner` running under a separate OS user.
- While Alice's turn is running, Bob (`regular`) posting a message sees it queued in dashed style via `QueuedRunsControl.tsx` with **no** `Send now` and **no** `Interrupt`; only Alice (creator) can click `Send now`; `owner`, `admin`, and `modo` (on unlocked threads per PR #11) see explicit **`Interrupt`** (and **no** `Send now`).
- When Bob's queued turn runs after Alice's turn finishes, the warm provider process recycles automatically and receives a fresh MCP token bound to Bob.

---

## Milestone 5 — Team Projects, Remote Environments, Local Sync & Thread Notes _(Merged — PR #5)_

**Goal:** Let teams assign projects to a Team, run threads across local laptops and ACL-controlled remote team environments, sync local team threads into the shared list, and collaborate safely on inaccessible environments via Thread Notes.

### Scope

- **Team Projects (`team_project_meta`):**
  - Assign a project to a Team during project creation or in Project Settings (optional `teamId` + `defaultViewId`, linked across environments via T3 Code's repository identity correlation).
  - New-thread environment picker on team projects: choose **local environment** or any **remote team environment** (including the Default Team Environment) permitted by the member's ACL.
- **Local-to-Team thread syncing & absolute local-execution boundary:**
  - Starting a team-project thread on a member's **local environment** syncs thread metadata (`creatorMemberId`, `viewId`, `execution_environment_id`, `is_local_synced`) and mirrored transcript/status updates into the Team Server's thread list so colleagues can view it (including read-only history when the laptop is offline).
  - Tool calls on a local-environment thread execute **strictly** on the owner's local machine—no colleague (not even `owner` or `admin`) can execute turns or tool calls on another member's local environment.
- **Team Environments & per-environment ACLs (`team_environments`):**
  - Team Server UI (**Settings → Teams → Environments**) & RPCs for `owner`/`admin` to attach additional remote `t3server` environments (building on `apps/server/src/peer`).
  - Per-environment `accessRule` (`roles` + `memberIds`, default: all roles on the team).
  - Server-enforced environment launch & read authorization across both client RPCs and Milestone 4's member-bound MCP tools (`t3_environment_*`, `t3_thread_launch`).
- **Inaccessible-Environment UX & Thread Notes (`team_thread_notes`):**
  - Whenever a colleague can read a team thread (via its View) but cannot execute on its attached environment (another member's local machine or an ACL-restricted remote environment), disable/grey out the standard composer and display a highlighted localized (`team.*`) banner directly above it with **`Fork this thread`** (portable context handoff onto an accessible environment) and **`Leave a note`** (when unlocked for the actor and permitted by `view.postRule`).
  - Inline Note Mode in composer creating immutable, SHA-256 `original_content_hash`-pinned **`Note from <pseudo>:`** timeline cards (author can delete while `pending`, never edit) with owner notification (reusing Milestone 2 notifications).
  - Owner inline controls directly on pending note cards (**`Accept`**, **`Edit`** storing `edited_body`/`edited_content_hash` while preserving `original_body` as `Note from Paul (edited by Jean):`, **`Reject`**, plus 1-click **`Accept & Send`** when composer is empty).
  - Allow submitting an **empty prompt** (`""`) whenever ≥1 note is accepted; show a compact 1-line bar disabling Send while visible pending notes remain undecided.
  - **Role-based confirmation friction:** accepting or editing a note authored by a **`regular`** member requires an explicit UI confirmation dialog showing the full exact text to be sent to the agent; **`modo`/`admin`/`owner`** authors skip the extra modal.
  - **Zero implicit injection & TOCTOU race protection:** every turn dispatch explicitly passes `acceptedNotes: Array<{ noteId, contentHash }>` verified server-side/by the executor before prompt construction; any note arriving concurrently right before Send is ignored by that turn and atomically **re-anchored after it** (`anchor_turn_id = newTurnId`).
  - **Mid-turn note approval:** notes arriving during an active turn anchor after it without auto-steering; if the owner approves a note while a turn is already running, it enters Milestone 4's native dashed queue (`QueuedRunsControl.tsx`) with creator-only **`Send now`**.

### Definition of Done

- Bob starts a thread on his **local environment** for a team project → tool calls run on Bob's local workspace while the thread syncs live into Alice's (`owner`) team thread list.
- Alice sees the greyed-out composer + inaccessible-environment banner on Bob's local thread (`Fork this thread` / `Leave a note`), cannot execute on Bob's laptop, and can fork the thread onto her own environment or leave a note.
- Bob sees an extra confirmation dialog when accepting/editing a note from a `regular` colleague vs. immediate 1-click approval for `owner`/`modo`, can edit a note while preserving `original_body`, can submit an **empty prompt** with an accepted note, and a concurrently arriving note is ignored by the dispatched turn and re-anchored after it.
- Approving a note while a turn is running queues it in dashed style via `QueuedRunsControl.tsx` with creator-only `Send now`.
- Restricting an attached remote environment to `admin` + Bob hides and server-blocks it for `regular` Alice (both RPC and MCP).

---

## Milestone 6 — Zero-Config Team Providers, Team Skills & Pre-Prompts _(Merged — PR #6)_

**Goal:** Let `owner`/`admin` configure team model providers once on the Team Server and `owner`/`admin`/`modo` curate team skills and pre-prompts so teammates get zero-config, strictly isolated team execution on both local and remote environments—never touching personal subscriptions or personal configs.

### Scope

- **Zero-Config Team Providers (`team_providers`):**
  - Provider authentication and configuration restricted strictly to **`owner`/`admin` on the Team Server** (**Settings → Teams → Providers**); teammates never sign in or enter team provider keys locally.
  - Auto-provision isolated virtual local instances (`team:<teamId>:<providerInstanceId>`) using separate `GEMINI_HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR` (ambient env vars stripped). Strictly restrict team-assigned projects to `team:<teamId>:*` (never expose or silently fall back to personal providers).
  - **Strategy A — `proxy`:** Authenticated **Team Model Proxy** (`/api/team/provider-proxy/:providerInstanceId/*`) for API-key / `BASE_URL` providers (Anthropic API, OpenAI API, Gemini API/Vertex, OpenRouter, LiteLLM, custom gateways) — zero company keys leave the Team Server, with centralized per-member usage accounting and instant cutoff on revocation.
  - **Strategy B — `token-lease`:** Authenticated **Ephemeral OAuth Token Lease** (`POST /api/team/provider-lease/:providerInstanceId`) for OAuth subscription harnesses:
    - Team Server holds the sole OAuth `refresh_token`, refreshes server-side when near expiry (`< 10 min`), **strips `refresh_token`**, and returns only short-lived `{ access_token, expiry }`.
    - **Codex:** injected in memory via `CodexManagedTokenBroker.ts` (`__managed-chatgpt-token`) — zero token on disk.
    - **Antigravity (Gemini):** transient `0600` `antigravity-oauth-token` (no `refresh_token`) inside the isolated `GEMINI_HOME` profile with `SSH_CONNECTION` + `AGY_ACP_FORCE_FILE_STORAGE=1`, purged on idle/disconnect/team leave.
    - **Claude OAuth:** injected into isolated `CLAUDE_CONFIG_DIR` without `refreshToken`.
    - **>1h turn continuity & revocation:** proactive pre-turn (`< 15 min`) and background (`expiry - 10 min`) renewal; transparent session reload + `ProviderContinuationRequests` auto-resume for RAM-caching harnesses (e.g., `agy acp`) if an active turn hits auth expiry after >1 hour; immediate token purge and clear error (no auto-resume) on `403` revocation.
  - Clear `remote-only` indicator for any CLI driver that cannot safely be proxied or leased without exposing a `refresh_token`.
- **Team Skills & Pre-Prompts (`team_skills`, `team_preprompts`):**
  - `owner`/`admin`/`modo` CRUD UI (**Settings → Teams → Skills & Pre-prompts**) and RPCs with audit metadata (`updated_by_member_id`, `updated_at`, `revision`, `content_hash`).
  - **Pure Markdown skills only:** `SKILL.md` (with YAML frontmatter) + optional text/Markdown reference files — server-rejected if executable scripts/binaries are included.
  - Scoped to **`"*"` (all providers)** or a **specific provider driver** (e.g., `"antigravity"`, `"codex"`, `"claudeAgent"`).
  - **Pre-prompt `injection_scope: "thread" | "turn"`:**
    - `"thread"` (default): materialized once into the isolated profile's global instruction file (`<teamProfile>/GEMINI.md`, `<teamProfile>/AGENTS.md`, `<teamProfile>/CLAUDE.md`) or injected once on Turn 1 (`<team_instructions>`) for generic ACP agents — prefix-cached with zero per-turn overhead.
    - `"turn"`: re-injected on **every turn** via the orchestrator turn-input envelope (`<team_turn_instructions>` / `buildCodexAdditionalContext` respecting its 4,000-byte entry cap) so critical rules survive context compaction.
  - **Isolated profile materialization & personal skill preservation:**
    - Never modify teammates' personal `~/.gemini`, `~/.codex`, or `~/.claude` directories.
    - Materialize team skills & `"thread"` pre-prompts exclusively inside `<teamProfile>` (`team:<teamId>:*`), keeping teammates' personal local skills accessible alongside team skills while giving **team skills precedence on slug/name collision**.
    - Real-time `team.assets.updated { revision }` WebSocket broadcast + `GET /api/team/assets?since=<revision>` delta sync (plus pre-turn revision check for offline laptops) refreshing provider skill catalogs immediately so new team skills appear in `/`.

### Definition of Done

- A teammate joins a team and starts a local thread on a team project with zero local provider setup: inference uses the Team Server's configured provider (`proxy` or `token-lease` with no `refresh_token` on disk), and personal subscriptions are never exposed or used.
- Revoking a member from the team immediately cuts off `proxy` requests and future `token-lease` renewals (purging the local ephemeral token on `403`).
- A pure-Markdown skill and both `"thread"` and `"turn"` pre-prompts created by `owner`/`modo` for `"antigravity"` (or `"*"`) auto-sync into a teammate's isolated local `team:<teamId>:*` profile without touching `~/.gemini`, keeping personal skills accessible while letting the team skill win on matching slug.

---

## Milestone 7 — Per-Turn GitHub Identity Forwarding _(Merged — PR #7)_

**Goal:** Eliminate shared bot accounts (`msl-agent`) and manual commit co-signing on shared environments safely, building directly on Milestone 4's author-switch session recycle and queue/interrupt controls.

### Scope

- **Per-member & optional team-automation GitHub credentials:**
  - Member GitHub connection in Settings:
    - **Phase 7a:** encrypted fine-grained PAT per member (zero OAuth App setup for self-hosted teams).
    - **Phase 7b:** GitHub OAuth / GitHub App user-to-server tokens for automatic short-lived token refresh and one-click sign-in.
  - Store `github_login`, `github_name`, `github_email` alongside encrypted credentials in `ServerSecretStore`, strictly scoped to `memberId` and never exposed to other members or read models.
  - Support an **optional dedicated Team Automation GitHub account** (`owner`/`admin` configurable in Settings → Teams, stored encrypted under `teamId`) for team scheduled tasks; if unconfigured, `team-automation` runs receive zero GitHub credentials (never borrowing any human member's PAT).
- **Per-turn credential brokering:**
  - Local turn-scoped Unix-socket / loopback credential broker (`GIT_ASKPASS` + `gh` wrapper / credential helper + per-turn `GIT_AUTHOR_*` / `GIT_COMMITTER_*` — never static long-lived `GH_TOKEN` env vars).
  - Short-lived single-turn credential lease for attached remote team environments (valid strictly for that `turnId`).
  - Immediate credential lease revocation when a turn completes, fails, is cancelled, is stopped via Milestone 4's `owner`/`admin` **`Interrupt`**, or when a thread creator uses **`Send now`** to steer a turn originally authored by another member.
- **Cross-user turn isolation:**
  - Integrate with Milestone 4's warm provider session recycle on `authorMemberId` switch so lingering subshells or in-memory state from User A's turn can never reach User B's turn or credentials.

### Definition of Done

- Alice starts a thread on the shared server, asks the agent to commit and open a PR → commit author and PR author are **Alice** (using Alice's token).
- Bob posts a follow-up turn in the same thread asking for another commit and push → warm session recycles, commit author and push credentials are **Bob**, with zero access to Alice's token.
- If an `admin` clicks **`Interrupt`** during Alice's active turn (or if a creator steers a foreign-authored turn via **`Send now`**), the active turn's GitHub credential lease is revoked immediately.

---

## Milestone 8 — Team Scheduled Tasks (`(team, env)` Scoping, Team Automation Ownership & Final Integration) _(Merged — PR #10)_

**Goal:** Deliver `(team, environment)` scheduled tasks with full team RBAC, `scheduled: ` team-owned threads (`ownerKind: "team"`), safe `team-automation` MCP & GitHub isolation, and complete cross-feature integration across M1–M9b (including upstream mobile compatibility, team providers, session recycle, and full E2E verification) while keeping personal scheduled tasks 100% upstream-identical.

### Scope

- **Scheduled thread prefix (`scheduled: `):**
  - Team-owned scheduled-task threads render everywhere with the fixed prefix **`scheduled: <title>`** (the earlier `team_workspaces.display_name` / `team.updateDisplayName` field is superseded and removed in Post-Audit UX).
- **`(team, env)` scheduled-task scoping & hidden virtual `"personal"` team (`team_scheduled_task_meta`):**
  - Scope scheduled tasks internally by `(teamScope, environmentId)` where non-team environments resolve to a virtual `"personal"` team scope in code that is **completely hidden in the UI** (personal scheduled tasks remain 100% upstream-identical).
  - Store team task metadata (`task_id PRIMARY KEY`, `team_id`, `environment_id`, `view_id`, `locked`, `mcp_access_level`, `created_by_member_id`, `updated_by_member_id`, `created_at`, `updated_at`) in sidecar `team_scheduled_task_meta` without altering upstream `scheduled_tasks`.
  - Group/filter team scheduled tasks by Team + Environment in **Settings → Scheduled Tasks** (`ScheduledTasksSettings.tsx`) and `ThreadAutomationsPanel.tsx` (hiding the virtual `"personal"` concept for non-team environments).
  - Keep Milestone 6's team-project provider invariant enforced on scheduled task creation/updates and runs (team projects use `team:<teamId>:*` providers only, never falling back to personal subscriptions).
- **Team Scheduled Task RBAC (replacing M3's temporary admin-only gate):**
  - **Read (`list`, `subscribe`, webhook delivery list):** Any active member with access to both the task's `environmentId` (`team_environments.accessRule`) and target `viewId` (`canReadTeamView`) can view team scheduled tasks (`regular` members in **read-only** mode, with webhook secrets/tokens masked/redacted for `regular`).
  - **Create / edit / enable-disable / delete / `Run now`:** Allowed for **`owner`, `admin`, and `modo`** on environments and Views they can access — strictly for **`mcpAccessLevel: "minimal"`** and **`locked: false`** tasks.
  - **Anti-escalation boundary (`owner`/`admin` only):** Only **`owner`/`admin`** may create or edit tasks with `locked: true` or `mcpAccessLevel: "elevated"`, and **`modo` cannot edit, delete, toggle, or modify prompts/webhooks on existing `elevated` or `locked` tasks**.
  - Apply the same RBAC consistently across WS RPCs, MCP scheduled-task tools, `ScheduledTasksSettings.tsx`, and `ThreadAutomationsPanel.tsx`.
- **Team-owned thread attribution (`ownerKind: "team"`), sidebar, notifications, posting & mobile compat:**
  - Extend `team_thread_meta` (`owner_kind: "member" | "team"`, nullable `creator_member_id` for `owner_kind = "team"`), `team_turn_meta` (`author_kind: "member" | "team_automation"`, nullable `author_member_id`), and `packages/contracts/src/team/schemas.ts` (`TeamThreadAttribution`, `TeamTurnAttribution`).
  - Threads created by team scheduled tasks stamp `ownerKind = "team"`, `creatorMemberId = null`, `viewId = taskMeta.viewId`, `locked = taskMeta.locked`, `executionEnvironmentId = taskMeta.environmentId`, and render everywhere as **`scheduled: <title>`** (web/desktop sidebar, header, hover card, command palette, and Milestone 9a's `upstreamMobileCompat.ts` — including `scheduled: ` prefix stripping on mobile rename and hiding unfollowed `ownerKind = "team"` threads in `owned_and_followed` mobile mode).
  - **Sidebar & notifications:** Hidden by default in the sidebar like colleagues' threads (revealed via "All team threads" toggle or `Follow`), producing **zero** notifications by default until explicitly followed (or when a member's own follow-up turn finishes).
  - **Posting, `Send now`, and `Interrupt`:**
    - If `locked === true`: only `owner` and `admin` may post.
    - If `locked === false`: **`owner`, `admin`, and `modo`** may always post in a team-owned scheduled-task thread (provided they can read its View), plus `regular` when `view.postRule` permits.
    - Mid-turn messages from `modo` (or other members) during an active automation run queue in dashed style (`QueuedRunsControl.tsx`) with **no `Send now` for `modo`** (and no `Send now` on automation runs).
    - **`Interrupt`:** `owner` and `admin` retain explicit **`Interrupt`** on active automation runs (immediately revoking any active automation GitHub lease); `modo` can also interrupt active turns on unlocked readable threads (PR #11); human follow-up turn authors can stop their own turn; `regular` members cannot interrupt automation runs or colleagues' turns.
- **MCP (`team-automation`), GitHub (M7) & warm session recycle (M4) wiring:**
  - Execute team scheduled-task runs under synthetic MCP principal **`team-automation`** (`taskId`, `teamId`, `projectId`, `environmentId`, `viewId`, `mcpAccessLevel: "minimal" | "elevated"`), never inheriting the configuring member's personal `memberId` or role.
  - **`"minimal"` (default):** Equivalent to `regular`, further narrowed strictly to the task's `projectId`, `environmentId`, and target `viewId` — cannot read `admin`-only Views, manage team settings/members/views/schedules, or launch threads outside its scope; propagated immutably (narrowing only) to subagents, `delegate_task`, and MCP-created child threads.
  - **`"elevated"` (opt-in, `owner`/`admin` only):** Grants admin-level MCP capabilities explicitly for trusted internal automation tasks.
  - Wire scheduled-task runs (both on the Team Server and on attached remote team environments, across `new_thread`, `reuse_thread`, and `fresh_session` modes) to Milestone 7's `authorKind: "team_automation"` GitHub broker path: uses the optional dedicated Team Automation GitHub account when configured, or executes cleanly with **zero GitHub credentials** when unconfigured (never borrowing a member's PAT).
  - Ensure `team_automation` ↔ human `memberId` author transitions on the same thread trigger Milestone 4's warm provider session recycle (rotating both the MCP token and the per-turn GitHub broker cleanly).
- **Final Translations & Full Multi-Member E2E Verification:**
  - Translate all new `team.*` keys across all 10 web locales (`vp run i18n:check`), keeping `apps/mobile/` completely untouched.
  - Add `scripts/scenarios/team/team-scheduled-tasks.e2e.ts` and verify the complete multi-member suite (`vp run scenarios:team`, all 9 scenarios covering M1–M9b).

### Definition of Done

- A team scheduled task creates a thread prefixed `scheduled: <title>` with `ownerKind = "team"` (no human `creatorMemberId`), hidden by default in the sidebar and in `owned_and_followed` upstream mobile mode until toggled or followed, with zero default notifications.
- Personal environments without a team display standard upstream Scheduled Tasks UI with zero mention of the virtual `"personal"` team.
- A `modo` can create/edit/`Run now` a `minimal` unlocked team scheduled task and post in its unlocked threads (queued dashed mid-turn with no `Send now`, with `Interrupt` on unlocked threads per PR #11), cannot create/edit/delete an `elevated` or `locked` task, and a `regular` member sees team tasks read-only (without webhook secrets).
- A `minimal` `team-automation` agent (and its delegates/subagents) cannot read `admin`-only Views or escalate privileges, while an `owner`/`admin`-configured `elevated` task works as expected.
- A team scheduled task runs cleanly without a GitHub account configured (returning zero GitHub credentials to `git`/`gh`), uses the dedicated team automation GitHub account when configured by `owner`/`admin`, and recycles the warm session cleanly whenever a human posts a follow-up turn.
- Full verification (`vp fmt`, `vp run i18n:check`, `vp run check:changed`, and all `vp run scenarios:team` scenarios) passes with zero changes to `apps/mobile/`.

---

## Milestone 9 — Upstream Mobile Compatibility, Sandboxing & Hardening _(Merged — PR #8 & PR #9)_

**Goal:** Make the unmodified official upstream mobile app work seamlessly against our forked Desktop and Team Server (zero changes to `apps/mobile`) and provide opt-in host-level worktree sandboxing for shared Linux runners.

### Scope

- **Milestone 9a — Server-Side Upstream Mobile Compatibility Layer _(Merged — PR #8)_:**
  - Member-bound standard pairing QR/codes (`team_pairing_meta`), non-team-aware client detection (`X-T3-Teams-Client`), on-the-fly title prefixing (`<creatorPseudo>: <title>` / `scheduled: <title>`) + rename prefix-stripping, per-member mobile visibility preference (`owned_and_followed` default vs. `all_accessible`), clear server-side errors, and `upstream-mobile-compatibility.e2e.ts` with zero modifications in `apps/mobile/`.
- **Milestone 9b — Optional Linux `bwrap` Worktree Sandboxing & `/proc` `hidepid=2` Hardening _(Merged — PR #9)_:**
  - Opt-in fail-closed `--team-bwrap-sandbox` / `T3CODE_TEAM_BWRAP_SANDBOX=1` (`apps/server/src/team/bwrapSandbox.ts`) isolating per-worktree, provider-profile, and per-turn broker/MCP socket binds (including M7's `TeamGitHubBroker` sockets/helpers), `capabilities.teamBwrapSandbox`, and the full Linux hardening runbook in [hub-runner-deployment.md](./hub-runner-deployment.md).

> **Completed post-M8 enhancements:**
>
> - **`modo` `Interrupt` + queued-message notifications _(Merged — PR #11)_:** `modo` can interrupt active turns on unlocked threads they can read (revoking active GitHub leases); thread creator and active turn author are notified whenever a colleague queues a message during an active turn.
> - **Per-team notification sounds _(Merged — PR #12)_:** `ClientSettings.teamNotificationSounds` keyed by `TeamId`, defaulting team threads to a distinct Web Audio `chime` preset (`chime`, `bell`, `marimba`, `pulse`, `classic`, `off`) with inline Preview in Settings → Notifications & Settings → Teams.
> - **Upstream `v0.1.13` sync + Antigravity plugins & `harnessProfiles.ts` _(Merged — PR #13)_:** Merged stable `v0.1.13` (`bc0f04da94`), preserved enabled personal Antigravity plugins in isolated `team:<teamId>:antigravity` profiles with Team Skill precedence, added `ProviderSetupError` non-retry regression coverage, and unified driver descriptors in `apps/server/src/team/harnessProfiles.ts`.
> - **Phase 7b — GitHub OAuth / GitHub App user-to-server tokens _(Merged — PR #14)_:** Added team GitHub App & OAuth App configuration (`owner`/`admin`), one-click browser OAuth with PKCE + cross-origin confirmation code, RFC 8628 Device Flow for LAN/Tailscale servers, automatic server-side token refresh with `needsReconnect` banners, and PAT fallback.
> - **Deep Audit Follow-ups _(Merged — PR #15 & PR #16)_:** Hardened local-sync View/Lock enforcement, remote GitHub lease attribution/session-revocation/TTL bounds, per-thread monotonic local-sync watermarks, `--team-hub-only` / `t3runner` seams, fork `remote-only` provider isolation, local-thread deduplication, `team.leave` / `team.delete` reverse states, tabbed `TeamsSettings`, personal-mode Settings Search isolation, and `<SelectValue>` localization.
>
> **Implemented follow-up:**
>
> - **Scheduled Thread Prefix (`scheduled: `), Universal Teammate Follow & Per-Member Snooze _(Implemented)_:**
>   1. **Remove team `displayName` & prefix scheduled threads with `"scheduled: "`:** Remove `displayName` / `teamDisplayName` / `team.updateDisplayName` from contracts, server RPCs/queries, `TeamsSettings`, Settings Search, and unused i18n keys (ignoring legacy `team_workspaces.display_name` column safely on upgrade); prefix all `ownerKind = "team"` scheduled threads with **`scheduled: <title>`** across web/desktop, notifications, and `upstreamMobileCompat.ts` (including stripping leading `scheduled:` on upstream mobile renames).
>   2. **Universal follow/unfollow across teammates & environments:** Ensure every active team member (`owner`, `admin`, `modo`, `regular`) can follow and unfollow any readable teammate or scheduled thread—including locked threads, read-only Views, local-synced threads, and threads hosted on attached remote environments (`t3runner` / remote `t3server`)—by resolving the owning Team Server via correlated thread location across `TeamThreadFollowButton`, sidebar context menu, `useThreadActionMenu`, and command palette.
>   3. **Per-member thread snoozing (`team_thread_snoozes`):** Allow every active member to snooze and unsnooze threads they created or follow (regardless of `postRule`, lock state, or execution access), including directly from in-app notification toasts as well as sidebar/header/command palette. Persist snooze strictly per `(threadId, memberId)` in sidecar `team_thread_snoozes` (never mutating upstream's shared `threads.snoozed_until`), intercept `thread.snooze` / `thread.unsnooze` on Team Servers + add `team.snoozeThread` / `team.unsnoozeThread` for attached remote environments, overlay `snoozedUntil`/`snoozedAt`/`lastSnoozeWakeAt` per session on all read/stream/MCP paths (transparently supporting unmodified upstream mobile), clear own snooze on unfollow, and filter both server relay/push notifications and client `ThreadNotificationCoordinator` independently per member so Alice snoozing Charlie's followed thread never affects Bob or Charlie.
>
> **Remaining optional future follow-ups (explicitly deferred):**
>
> - **Release packaging dry-run:** Trigger `teams-release.yml` to verify signed/unsigned desktop + CLI release artifacts before cutting `v0.1.13-teams.1`.

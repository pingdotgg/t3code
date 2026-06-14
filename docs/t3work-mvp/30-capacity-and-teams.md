# 30 — Capacity & Teams (capacity page, local teams, off-days, overhead)

Status: **draft for review** · builds on the shipped Tempo capacity read (29 §10.2,
server `t3work-tempo.ts`, 2026-06-11)
Owner: PJ
Related: 00-vision, 02-additive-architecture, 03-project-browser, 16-action-recipes,
21-context-tool-catalog, 29-planning-space

## 1. Summary

A new **Capacity** surface: one page where a user sees, per sprint, how much time each
person actually has and how full they are — and manages the local planning model that
feeds it: **teams** (self-defined groups of people), **off-days**, and **overhead
percentages**. Capacity stops being a planning-space-only number and becomes a
platform-level service: any surface that renders a person can render their capacity,
and agents can read and adjust the model through tools.

Two principles:

1. **Tempo is a source, not the store.** Tempo `user-schedule` (when connected) is the
   base signal for scheduled hours. Everything the user authors here — teams, off-days,
   overhead — is a **local overlay** persisted in the backend SQLite, never written
   back to Tempo or Jira. Off-days entered locally are planning assumptions, clearly
   marked as such; absences that already exist in Tempo show up via the schedule and
   are not duplicated.
2. **One resolution pipeline, used everywhere.** Effective capacity is computed in one
   server function and consumed by the capacity page, the planning-space rail, the
   backlog, and agent tools — never re-derived per surface.

## 2. Scope

In scope (v1):

- New `capacity` dashboard mode (third mode next to `backlog` and `my-work`).
- Local **teams**: create/rename/delete, pick members from known assignees +
  Tempo team rosters; multiple teams; per-project default team; team as a backlog
  filter and as the planning-space rail roster.
- **Off-days**: per person, date or date-range entries with a label and an
  hours-per-day override (full day off by default, half-days supported); editable for
  self and — since this is a local planning overlay — for anyone (see §5 trust note).
- **Overhead percentage**: global default (e.g. 80% = 20% reserved for meetings,
  support, context switching) and per-person overrides.
- **Per-sprint capacity board**: people × sprints grid with effective capacity,
  assigned load, remaining load, and fullness; current + future sprints of the
  selected board.
- Setup mode + provider connections settings (§7): Tempo OAuth/token onboarding,
  per-provider auth state in settings.
- Agent integration: context contract, add-to-chat, read/view-state/mutation tools,
  recipe hooks (§8).
- Cross-surface capacity component + hook (§9): planning-space rail, backlog
  ownership/assignee surfaces, assignee pickers.

Out of scope (v1): writing absences to Tempo/Jira; cross-user sync of local overlays
(single-user local DB today, multi-user later via the same tables); vacation approval
workflows; FTE cost reporting.

### 2.1 Placement

Capacity is a **dashboard mode**, not a per-board view mode: teams and off-days span
boards and sprints, and the page is useful without a backlog selection. Entry points:

1. Dashboard mode switch: `Backlog · My Work · Capacity`.
2. From the planning-space rail: clicking a dock's capacity arc deep-links to that
   person's row on the capacity page.
3. Agent tool `t3work.project.open_dashboard_mode` gains the `capacity` target.

## 3. Capacity resolution pipeline

One server-side function (extending `t3work-tempo.ts` into `t3work-capacity.ts`):

```
effectiveCapacity(person, window) =
  round(
    baseScheduleSeconds(person, window)      # 1. Tempo user-schedule, else fallback
    − offDaySeconds(person, window)          # 2. local off-day overlay
  ) × overheadFactor(person)                 # 3. per-person ?? global, e.g. 0.8
```

1. **Base schedule** — Tempo `user-schedule` per day (`requiredSeconds`; part-time +
   holiday schemes resolved), minus **unavailability plans**: non-issue Tempo plans
   plus plans on issues *outside the planned project* (verified live: off-project
   time is modeled as plans on internal issues like INT-2 "Nicht für Sprint/Projekt
   verfügbar"). Plans on the planned project's own issues are sprint work and never
   subtract. Issue→project resolution goes through the Atlassian client, memoized.
   Fallback without Tempo: configured hours/day (global setting, default 8h) ×
   Mon–Fri workdays in the window.
2. **Off-day overlay** — local entries clipped to the window. An off-day on a day with
   0 scheduled seconds subtracts nothing (no double counting with Tempo absences).
3. **Overhead** — multiplier applied last; per-person override wins over the global
   default. Shown explicitly in the UI ("32h × 80% = 25.6h") so the number is never
   mysterious.

Load (assigned/remaining) reuses the planning-space formula: Σ subtask original /
remaining estimates per assignee in the sprint, + subtask-less stories' own estimates.
This lives in shared code so the capacity page and the rail cannot diverge.

## 4. Data model (backend SQLite, migration `t3work-035_CapacityTeams`)

```sql
t3work_teams              (id, name, project_id NULL,        -- NULL = global team
                           is_default INTEGER, created_at, updated_at)
t3work_team_members       (team_id, account_id, display_name, role NULL, sort_order)
t3work_capacity_off_days  (id, account_id, date_from, date_to, label,
                           seconds_per_day NULL,             -- NULL = full day off
                           created_by, created_at)
t3work_capacity_settings  (scope,                            -- 'global' | account_id
                           overhead_percent NULL, hours_per_day NULL, updated_at)
```

Notes:

- `account_id` is the Atlassian accountId — the join key shared with backlog
  assignees and Tempo. People who exist only locally (no Jira account) are out of
  scope for v1.
- Teams may be global or pinned to a project; the backlog default-filter uses the
  project's default team, else the global default team.
- All tables are local overlays — deleting them loses no external data.

## 5. Surface shape

### Capacity board (main view)

- **Rows**: people of the selected team (or "everyone seen on this board"). Row head =
  avatar, name, overhead chip (e.g. "80%"), off-day count for the visible range.
- **Columns**: sprints of the selected board (active + future, horizontally
  scrollable; closed sprints collapsible for retro comparison).
- **Cell**: effective capacity vs assigned vs remaining, as a compact bar
  (`assigned/effective`, red when over) with the same color language as the
  planning-space arcs; tooltip = full breakdown (schedule − off − overhead, item
  count, remaining).
- **Footer row**: team totals per sprint — Σ effective capacity vs Σ assigned. This is
  the "sprint target line" answer from 29 §12.
- Header: team picker · board/sprint range picker · "manage teams" · settings
  (global overhead, fallback hours/day, Tempo token status).

### Person drawer (click a row)

- Calendar strip for the visible range: scheduled hours per day (from Tempo or
  fallback), off-days editable inline (click-drag a range → label + full/half day),
  Tempo-sourced zero-days rendered read-only with a Tempo badge.
- Per-person overhead override.
- Their sprint items (grouped per sprint) with estimates — jump links into backlog.

### Teams manager (dialog or side panel)

- Team list; create with name; member picker fed by board assignees + Tempo team
  rosters (`GET /4/teams`, `/members`) as suggestions; drag to order; set default
  (global and/or per project).

### Trust note ("if permitted")

The local DB is single-user, so v1 permission = everything editable. The guardrail is
provenance, not ACLs: entries store `created_by`, off-days for other people render
with an "assumption" tag, and Tempo-sourced absences are read-only. When multi-user
backends arrive, the same tables gain owner-scoped write checks.

## 6. Server API

`/api/t3work/capacity/*` route family (same pattern as the tempo routes):

```
POST /capacity/resolve        {accountIds, from, to}            → per-person breakdown
POST /capacity/board          {boardKey?, teamId?, sprintIds[]} → grid payload (people × sprints,
                                                                  capacity + load merged server-side)
POST /capacity/teams/list|create|update|delete
POST /capacity/team-members/set                                 (full-replace per team)
POST /capacity/off-days/list|upsert|delete
POST /capacity/settings/get|set
```

`/capacity/resolve` wraps the shipped `loadT3workTempoCapacity` as stage 1 and applies
overlays; `/capacity/board` joins it with the backlog cache (sprint windows + per-
assignee load sums come from `t3work_atlassian_backlog_issues`) so the web client gets
one payload per board.

## 7. Setup mode & provider connections

Tempo auth is separate from Jira auth (own token / own OAuth app), so the capacity
surface needs a first-run path instead of silently falling back to defaults.

### 7.1 Capacity setup mode

When the page opens and `/tempo/status` reports unconfigured, the board renders in
**setup mode** instead of fake numbers:

- A setup card explains the three source tiers and lets the user pick one:
  1. **Connect Tempo (OAuth)** — standard flow per 29 §10.2: redirect URI
     `${origin}/oauth/callback` (same convention as `t3work-useAtlassianOAuth`),
     token exchange server-side, refresh handled like the Atlassian OAuth store.
  2. **Tempo API token** — paste field posting to `/api/t3work/tempo/token`
     (shipped).
  3. **No Tempo** — local-only schedule (hours/day × workdays); everything else
     (teams, off-days, overhead) works identically.
- The same card surfaces inline when a person's schedule comes back 403/401 (token
  valid but lacking permission to read others) — degraded state, not an error wall:
  rows without readable schedules use the fallback schedule with a "no Tempo data"
  badge.
- Setup state is re-checkable from the page header (Tempo badge: connected /
  fallback / error).

OAuth client configuration follows the existing Atlassian convention — repo-root
`.env` (gitignored, loaded via `loadRepoEnv`) / process env:

```
T3WORK_TEMPO_CLIENT_ID=...        # OAuth app client id
T3WORK_TEMPO_CLIENT_SECRET=...    # server-side only, never shipped to the client
T3WORK_TEMPO_API_TOKEN=...        # alternative: static token, skips OAuth entirely
```

Exchanged/refreshed Tempo OAuth tokens persist next to the Atlassian auths
(`secrets/t3work-tempo-auth.bin`), superseding the plain token file when present.

### 7.2 Settings → Connections (separate story, shared with all providers)

A new **Connections** section in app settings — one row per provider integration
(Atlassian/Jira, Tempo, GitHub, future Sources per doc 00):

- shows auth state (connected as <user/email>, token kind: OAuth/basic/API token,
  expiry/refresh state, last successful call)
- actions: connect / re-authenticate / switch account / disconnect (deletes the
  persisted secret)
- multiple accounts per provider where the store supports it (Atlassian already
  keyed by accountId)
- providers register their connection descriptor (label, icon, status probe,
  connect/disconnect handlers) so new Sources appear without editing the settings
  page — doc 04 integration-platform pattern.

This is the durable home for "login/logout/change user/see auth state"; the capacity
setup card (§7.1) is a contextual shortcut into the same machinery, not a second
implementation.

## 8. Agent integration (per 21's tool classes)

Context contract (add-to-chat and kickoff aside): `dashboard.capacity.summary` context
file with `{teamId, teamName, sprintWindows, perPerson: {accountId, name,
effectiveSeconds, assignedSeconds, remainingSeconds, offDays[], overheadPercent}}` —
the agent reasons over the same resolved numbers the user sees.

Tools:

```text
# read (safe)
t3work.capacity.read_board            # current grid as structured data
t3work.capacity.read_person           # one person's breakdown incl. off-days
t3work.capacity.list_teams

# view-state (safe)
t3work.capacity.open_view             # open capacity mode, optional team/sprint focus
t3work.capacity.filter_by_team        # also usable from backlog (sets team filter)
t3work.capacity.focus_person

# local mutations (draft-style: applied to the local overlay, undoable toast,
# never an external write — same trust level as view prefs)
t3work.capacity.set_off_days          # {accountId, from, to, label, halfDay?}
t3work.capacity.remove_off_days
t3work.capacity.set_overhead          # {accountId | "global", percent}
t3work.capacity.create_team
t3work.capacity.set_team_members
t3work.capacity.set_default_team
```

Recipe seeds: "plan next sprint" (compare team capacity vs candidate load and propose
moves — pairs with planning space), "who can take this?" (rank team members by
remaining capacity for the ticket's sprint), "log my time off" (conversational off-day
entry), "sprint health" (over-capacity people + unassigned hours summary).

## 9. Cross-surface integration

- `useCapacity(projectId, {accountIds, window})` web hook backed by `/capacity/resolve`
  with a small per-project cache + freshness polling (doc 18 pattern). Replaces the
  planning-space-only `useTempoCapacity` (which becomes the stage-1 internal).
- `<CapacityRing accountId sprintId>` — the planning-space arc extracted into a shared
  component (ring + `assigned/effective` label + breakdown tooltip). Consumers:
  planning-space rail (swap-in), backlog ownership view group headers, assignee
  pickers (sorted by remaining capacity, ring per option), my-work header (own
  capacity for the active sprint).
- Backlog: team picker chip in the filter row (`assigneeFilter` extended by
  `teamId`); planning-space rail roster = default team ∪ assignees seen in the sprint.

## 10. Delivery plan

1. **P1 — Model + resolve**: migration 035, settings/off-days/teams CRUD routes,
   `effectiveCapacity` pipeline over the shipped Tempo client, `/capacity/resolve` +
   `/capacity/board`, unit tests for the pipeline (Tempo present/absent, overlays,
   overhead rounding). Exit: curl the board payload with real data.
2. **P2 — Capacity page**: dashboard mode, board grid, person drawer with off-day
   editing, teams manager, settings. Exit: manage my off-days + team and see correct
   per-sprint fullness for PW sprints.
3. **P3 — Cross-surface**: `useCapacity` + `CapacityRing`, rail swap-in, backlog team
   filter + default team, assignee-picker ranking.
4. **P4 — Setup & connections**: Tempo OAuth flow + persisted auth store, capacity
   setup mode card, Settings → Connections section with provider descriptors
   (Atlassian + Tempo first; GitHub row reuses its existing store).
5. **P5 — Agent**: context file, tool set, recipe seeds, safety-matrix entries in
   doc 21.

## 11. Open questions

- Sprint columns for boards with irregular cadence: derive windows strictly from
  sprint dates (current behavior) or allow custom date ranges as columns?
- Should team membership suggestions auto-sync from Tempo teams (one-way refresh
  button) or stay purely manual after creation?
- Overhead semantics for over-capacity warnings: warn at >100% of effective, or also
  soft-warn at >100% of pre-overhead schedule?
- Off-day granularity: is full/half day enough, or do we need arbitrary hours/day?

# 29 — Planning Space (3D sprint planning view)

Status: **ready to implement** · validated via 8 interactive mockup iterations, live
Jira data (PW Sprint 7.6 fed into the prototype) and live Tempo API verification
(2026-06-10)
Owner: PJ
Related: 02-additive-architecture, 03-project-browser, 05-atlassian-mvp,
10-engineering-constitution, 13-resource-references, 18-integration-freshness-polling,
21-context-tool-catalog

## 1. Summary

A new backlog view mode purpose-built for **sprint planning day**: a zoomable, pannable
"space" in which epics, stories and subtasks live as spatial objects, the team sits in
a dock rail with capacity rings, and the three planning activities — moving work
in/out of the sprint, assigning, estimating + drafting subtasks — are all direct
spatial manipulations with live animation.

The view replaces the current `hierarchy`, `planning` (lanes) and `ownership` view
modes. End state: **two view modes only — `table` (default) and `planning-space`.**

Core model (final, after real-data iterations): **the subtask is the planning unit.**
Subtask cards are the primary objects (title, hour estimate, owner); stories are
container frames that hold a grid of all their subtasks; epics are constellations of
story frames. One persistent scene + one camera; grouping modes are re-projections of
the same nodes; zoom depth is semantic; overlap is impossible by construction.

## 2. Scope

In scope (v1):
- New `viewMode: "planning-space"` in the backlog dashboard, behind a feature flag initially.
- Read path: epics, stories, subtasks, sprint membership, assignee, estimates
  (hours on subtasks; board estimation field on stories, read-only aggregate display),
  planning state, issue links.
- Write path: assign owner (story and subtask), change subtask hour estimates,
  move in/out of sprint, create + edit subtasks (first-class: title, description,
  owner, time estimate), edit story summary/description.
- Capacity + availability from **Tempo** (verified, §10.2) with config fallback.
- Filtering (§5) — replaces the current backlog filter row for this view.
- Chat/agent integration: add-to-chat, agent context contract.
- Live updates: poll/refresh diffs animate, attention flash for changes affecting
  the current user.

Out of scope (v1): multi-user presence; html-in-canvas paint backend (§9);
mobile/touch-first; status transitions (kanban remains the tool for that).

### 2.1 Placement and entry points

Planning space is a **backlog view mode, not a dedicated route** — it fits the
backlog thematically and reuses its entire data spine (board/sprint/saved-filter
selection, cache + freshness, write-through endpoints). Decision confirmed.

Entry points:
1. **Quick view toggle** — a two-state segmented control (table icon ⇄ planning-space
   cube icon) placed directly left of the existing ellipsis options button in the
   backlog header (`ProjectBacklogOverviewFilters`), same `size-8` bordered-button
   styling, with tooltips. The toggle only offers `table ⇄ planning-space` — the
   legacy modes stay menu-only during the transition and disappear in P5, at which
   point the toggle covers all modes that exist.
2. **Options menu** (existing `ProjectBacklogOptionsMenu` view-mode section) remains
   the canonical switcher and the fallback when the header row is too cramped: below
   a container-width threshold the quick toggle hides and switching collapses back
   into the ellipsis menu.
3. Deep-linkable: `viewMode` persists per project (existing mechanism), so the app
   reopens into planning space if that's where you left off; fullscreen/theater is
   an affordance inside the view itself.

## 3. Scene model

### 3.1 Coordinate system, camera, zoom

- World space `(x, y, z)`; perspective projection with focal length `F = 600`:
  `scale = F / (F + z − cam.z)`. Depth planes: epics z = 520, story frames z = 260.
- All camera motion is target + lerp (k ≈ 0.1 per frame).
- **Zoom speed is perceptually constant**: `Δz = deltaY · k · (F + Z_story − cam.z)`.
- **Zoom is cursor-anchored**: the world point under the pointer stays fixed —
  recompute `cam.xy` from the anchor after each `Δz`, against the camera *target*.
- **Layout must be zoom-independent** (hard rule). The earlier zoom-coupled "spread"
  (spacing growing with depth) made node targets move *while* zooming; combined with
  cursor anchoring and snap, the view careened uncontrollably at high zoom (v7 bug).
  Replaced by true-size masonry packing (§3.4): positions are static per
  grouping mode, so cursor-anchored zoom is exact and stable.
- Band-5 magnetic snap is gentle (pull ≈ 0.04), only when fully idle (≥ ~1.5s after
  the last wheel/pointer input), and always yields to an explicit snap target set by
  navigation jumps. Manual panning clears it.
- Viewport dimensions are measured live every frame.

### 3.2 Depth bands (semantic zoom)

Gauge labels: **All · Epics · Stories · Cards · Tasks · Full.**

| # | Gauge label | Trigger | Summary |
|---|------------|---------|---------|
| − | All | dedicated mode | **epic overview**: epics ONLY (no children) as a dense tile grid, fully readable |
| 0 | Epics | s < 0.3 | epic star systems + stories as planning-state dots |
| 1 | (transition) | 0.3–0.62 | key + Σ-hours chips |
| 2 | Stories | 0.62–0.92 | titled frames + subtask dot rows |
| 3 | Cards | 0.92–1.3 | frames open: **grid of all subtask cards** (hours · title · owner) |
| 4 | Tasks | 1.3–1.8 | subtask cards grow: 2-line titles, hour steppers active |
| 5 | Full | ≥ 1.8 | one story frame as a fully interactive document (§3.5) |

- **All is not a far camera position — it is an epic overview projection.** Children
  (stories/subtasks) are hidden entirely; epics re-target into a dense viewport-
  filling tile grid (rows × cols chosen from epic count and aspect ratio). Each tile
  renders at a **fixed, fully readable screen size** — tile content does not scale
  with camera depth (the v8 fit-to-bounds approach left labels unreadably small and
  is rejected): name (2-line clamp), key, item count, Σ hours, ready/total progress,
  state-distribution mini-bar. Zooming in from All crossfades back into the normal
  spatial bands at the epic the cursor is over; tiles follow the group-anchor
  contract (§6.1): click = spotlight, double-click (or the tile's corner enter icon)
  = frame that epic's cluster at the Stories band. The gauge treats All as a
  discrete stop below Epics.
- Band content swaps crossfade; counter-scale inflation is part of the overlap
  budget; the gauge is a draggable slider with clickable band labels.

### 3.3 The subtask-primary model

**Subtask card** (the primary planning object — visually what a "story card" was in
early iterations): hour-estimate chip + stepper (− h +), title (1-line at Cards,
2-line at Tasks/Full), owner dot (click = assign mode for that subtask; drag the
card onto a dock/person = assign). No checkboxes, no done-state chrome — planning
space plans new work; already-resolved subtasks merely render dimmed.

**Story frame** (container): header row — type icon (`JiraIssueTypeIcon`), key,
done-check, context chip (if outside sprint), **read-only Σ hours** (aggregate of
subtasks; story-level estimate steppers were removed — "± estimate makes no sense on
stories in planning space"), story owner avatar (click = assign story) — then the
1–2-line title, then the **subtask grid: 2 columns, ALL subtasks visible** (no cap,
no inner scroll below band 5; the frame grows and the packing accounts for it).
Stories with no subtasks show an inviting empty state ("planning starts here").
Context parents (not in sprint) render with dashed borders.

**Epic node**: circle with Σ hours + name + stats line + description, text stacked
above the circle; fades out entirely past band 4.

**Epic interactions**: epics are group anchors and follow the uniform group-anchor
contract (§6.1) — click = spotlight, double-click = frame the cluster, right-click =
context menu (Open details → epic panel, §7 · Add to chat · Open in Jira), drop a
story frame on the epic (node or All tile) = re-parent with undo. Epic spotlight
shares state with the filter bar's epic chips.

### 3.4 No-overlap by true-size masonry packing

- Frame height is a deterministic function of content:
  `hF = header + ceil(subtasks/2) · cellH + padding` (computed at the largest
  pre-planet band's CSS sizes).
- Within a cluster (epic / owner / sprint-zone column set), frames pack into 2–3
  columns shortest-column-first (deterministic masonry — no force simulation).
- Cluster rows are laid out cumulatively by the tallest cluster in the row
  (extent-aware packing — fixed-grid anchors were rejected after real data showed
  cluster sizes 1–8).
- Invariant (unit-testable): for every band, neighboring frame rects (at that band's
  CSS sizes × scale, including counter-scale inflation) are disjoint.
- Width adaptation: anchor x-positions scale with `clamp(W/780, 1, 1.45)`.

### 3.5 Band 5 — the planet frame (fully interactive editor)

The story frame, grown into a scrollable document — and at this band it is a
**complete working editor**, not a richer preview. Everything editable in the panel
is editable here, inline:

- **Story**: title (inline edit), description (ADF editor in place), owner picker,
  sprint toggle.
- **Subtasks — full lifecycle**: add (the canonical micro-flow, §6.5), remove
  (per-card ✕ with undo toast), estimate (steppers + free hour input, §6.3), assign
  (owner affordance → assign mode, §6.2), reorder (drag within the grid), and
  **expand**: clicking a subtask card flips it open in place — the band-5 rendering
  of the same subtask detail that opens as a side panel at lower bands (§6.4, §7) —
  to view and edit its own description without leaving the planet.
- Related-story chips (in-set: camera flies there + becomes snap target; out-of-set:
  fetch on demand), links row, attachments (lazy-fetched).

Mechanics: breadcrumb (parent epic · sprint · key) at top; header row is the drag
handle; the body is native scroll/selection/editing territory — pointer capture and
camera input must never steal events from form controls; the side panel is
suppressed at this band; breadcrumb and related-chip camera targets are evaluated at
the *destination* zoom. All edits are optimistic write-through with rollback, same
as everywhere else.

### 3.6 Estimate model (verified live)

- **Subtasks: always hours** (`timetracking.originalEstimateSeconds`) — the editable
  estimate everywhere in this view (steppers: 0 / 0.5 / 1 / 2 / 3 / 4 / 6 / 8 / 10 /
  12 / 16 / 20 / 24h + free input in panel).
- **Stories: read-only aggregate** (Σ subtask hours; falls back to the story's own
  time estimate when it has no subtasks). The board's points field, where used, is
  shown in the panel as reference only.
- Planning state: a story is "estimated" when its subtask aggregate (or own time
  estimate) is non-zero — verified necessary on real data (0 stories with points,
  67/74 subtasks with hours).

## 4. Grouping modes (re-projections)

Three modes: **by epic** (default), **by sprint**, **by owner**. Switching re-targets
the same nodes (no re-mounts), pins the focused/most-central frame on screen, and
plays the rotateY yaw cue around it.

- **by epic**: epic clusters in rows of ~4. **Cluster order is link-affinity-driven**:
  build an epic adjacency graph from issue links between their stories, then order
  greedily so epics that reference each other sit adjacent (tie-break: story count).
  Random/alphabetical epic placement was rejected — related epics ended up far apart.
- **by sprint**: two zones (sprint / outside-sprint context parents); dropping a frame
  on either half moves the story in/out of the sprint.
- **by owner**: one masonry cluster per team member + Unassigned, rows of 4, any team
  size. In-space owner headers are drop targets and drag sources.

## 5. Filtering

(unchanged from prior revision: collapsible bar — text, epic chips, owner = shared
state with dock spotlight, planning-state chips, "mine", saved-filter presets;
spotlight strength dims to ~14% with stable layout, solo strength re-packs; filter
state in agent context and persisted. Owner spotlight matches a frame when the story
OR any of its subtasks belongs to the owner.)

**Spotlight propagation (hard rule)**: muting applies to the whole scene graph, not
just story frames. An epic node (and its All-grid tile) takes the muted opacity when
*none* of its stories match the active filter; every edge inherits
`min(opacity(endpointA), opacity(endpointB))`. A spotlight where unrelated epics and
connection lines stay at full strength reads as broken (v8 gap).

## 6. Interaction contract — one primitive per concept, every surface

Principle (binding): an interaction learned once works identically on every
representation of the same concept — card in space, planet row, panel row, dock,
tile. Each row below is implemented as **one shared primitive**; surfaces may add
shortcuts but never divergent behavior. This section is the single source of truth;
other sections reference it.

### 6.1 Group anchors — epics are places, owners are filters

Group anchors split into two semantic families (revised during live testing —
the earlier uniform click-equals-spotlight rule made epics feel inert):

**Epic anchors** (epic node, All-grid epic tile) are *places you enter*:
- **Click = fly into the cluster**: camera frames the epic's stories + subtasks
  at the Stories band. From the All overview this exits the overlay.
- **Spotlighting an epic** stays available via the filter bar's epic chips and
  the context menu — shared filter state as before.

**Owner anchors** (dock, in-space owner header) are *filters you toggle*:
- **Click = spotlight toggle** (camera never moves): dims everything outside the
  member's work to ~14% with full propagation (§5); one shared state with the
  filter bar; click again / Esc clears.
- **Double-click = frame the member** (switches to by-owner mode if needed).

Shared by both families:
- **Right-click = context menu**: Open details (group panel, §7) · Add to chat ·
  Open in Jira.
- **Drag source**: owner anchors drag onto items to assign (§6.2). Items
  themselves are not draggable (revised: node-dragging made navigation finicky),
  so re-parenting happens via the context menu / panel, not by dropping.

### 6.2 Assignment — `assign(item, person | null)`

One primitive for stories and subtasks alike; all paths converge on the same write,
flight animation, capacity-arc tween and toast:
- **Owner affordance** (avatar/dot) on ANY representation of the item — frame
  header, subtask card, planet row, panel row — click → **assign mode**: the rail
  expands and lifts, the affordance highlights, the hint names the target; resolve
  by clicking any owner anchor (dock or in-space header); Esc cancels. There is no
  separate inline picker anywhere — assign mode is the picker.
- **Drag item → owner anchor**, or **drag person (dock/header) → item** (story frame
  or individual subtask card). In by-owner mode, dropping a frame near a cluster
  resolves to that cluster's owner.
- Domain rule, applied on **every** path equally: assigning a backlog *story* during
  planning also commits it to the selected sprint (toast mentions both effects);
  *subtask* assignment never changes sprint membership; unassign = the Unassigned
  anchor.

### 6.3 Estimates and sprint membership

- **Subtask hours**: one stepper ladder (0 / 0.5 / 1 / 2 / 3 / 4 / 6 / 8 / 10 / 12 /
  16 / 20 / 24h) rendered identically on subtask cards (bands 4–5), planet rows and
  panel rows; free numeric input wherever a text field exists (panel, planet). One
  write (`timetracking.originalEstimate`), one optimistic-rollback rule.
- **Story estimate**: read-only Σ everywhere (frame chip, panel effort row, epic Σ).
  No surface may render a story-level estimate editor.
- **Sprint membership**: drag frame across by-sprint zones ⇄ sprint toggle in
  panel/planet — same write, same toast.

### 6.4 Details and navigation

- **Click an item → that item's detail; the camera never moves.** Story frame
  (bands 0–4) → story panel; subtask card (bands 3–4) and panel subtask row →
  subtask panel; at band 5 the same details render in place (planet = story detail,
  flipped-open card = subtask detail). The side panel is a per-item singleton that
  re-binds — never stacks.
- **Navigation jumps** (related chips, parent breadcrumb, panel navigate links,
  group framing): camera flight with the target computed at the *destination* zoom,
  setting the snap target; an open panel follows to the destination item.

### 6.5 Create, remove, undo

- **Add subtask** — one micro-flow wherever it appears (planet inline row, panel
  input, story context menu): type title → Enter creates optimistically → focus
  lands on the new subtask's hour stepper → the card appears in space immediately.
- **Destructive/structural mutations** (remove subtask, re-parent story) → toast
  with undo. All other mutations → plain toast.
- Every mutation animates; nothing teleports — including remote and agent-initiated
  changes, which use the same diff→animate path.

### 6.6 Team rail

Bottom HUD rail, one dock per member + Unassigned; capacity arc = Tempo-derived
capacity (§10.2) vs. live load; horizontal scroll beyond viewport width (18 active
assignees verified — overflow is the norm); sorted current-user-first then by load.
Collapsible via right-edge icon toggle; collapsed by default in by-owner mode and at
band 5; auto-expands during assign mode and any drag (docks lift/enlarge as
targets). Docks are group anchors (§6.1): click = spotlight, double-click = frame
the member, drop = assign.

### 6.7 Feedback and escape

- **Drop-target preview is identical everywhere**: lift + dashed outline on hover —
  docks, owner headers, epic anchors, zone halves.
- **Esc ladder** (global, one level per keypress): cancel active drag → close
  panel / in-place detail → cancel assign mode → clear spotlight/filters.
- **Context menus share one structure**: common actions first (Add to chat · Open in
  Jira), then item-specific extras (Add subtask on stories · Open details /
  Spotlight on group anchors).

## 7. Panels

One panel family — per-item singleton, leader line to the item, camera never moves,
suppressed at band 5 (the planet is the editor; entering band 5 closes panels):
- **Story panel** (bands 0–4): header (key, epic, state) · editable title · effort
  (read-only Σ, §6.3) · owner affordance (→ assign mode, §6.2) · sprint toggle ·
  navigate (parent epic, related, reveal-in-space; §6.4) · description (ADF) ·
  subtask rows (steppers §6.3, owner dots §6.2, row click → subtask panel §6.4) ·
  add-subtask (§6.5) · activity · actions.
- **Subtask panel**: header with parent-story jump link · editable title · hour
  stepper + free input · owner affordance · description (ADF) · actions. Identical
  content to the planet's flipped-open card — one component, two anchorings.
- **Epic panel** (via group context menu → Open details): name · editable
  description · stats (items, Σ hours, ready/total, progress) · story list with
  jump links · actions.

## 8. Live updates, attention, chat/agent integration

(unchanged: diff→animate for remote/agent mutations; flash + dock pulse + toast for
changes targeting the current user; right-click add-to-chat / open-in-Jira; agent
context contract `{viewMode, grouping, cameraBand, focusedItem, filters,
sprintStats, pinnedToChat}`; theater/fullscreen.)

## 9. Architecture

Module layout, conventions (t3work- prefixes, additive architecture, constitution,
vitest under vite-plus), scene/renderer split as the html-in-canvas seam, optimistic
write-through, freshness polling — unchanged from prior revision. Quality bar:
continuous rAF, exponential lerps, every mutation animates, 60fps at 200 stories +
400 subtasks (P1 measurement gates band 0–1 density).

New invariant tests for P1: masonry disjointness per band (§3.4), cursor-anchored
zoom exactness (anchor drift < 1px over a full zoom sweep), fit-all bounds.

## 10. Data sourcing (verified live, 2026-06-10)

### 10.1 Jira (via existing Atlassian client)

| Datum | Source | Status |
|-------|--------|--------|
| Epic → story → subtask hierarchy | `parent` + classic Epic Link (`customfield_10014`) — handle both; match subtasks by `issuetype.subtask === true`, never by name (type is named "Task" here) | ✅ verified |
| Subtask estimate | `timetracking.originalEstimateSeconds` | ✅ verified |
| Story aggregate | `aggregatetimeoriginalestimate` (on `ProjectTicket`) | ✅ verified |
| Story points (reference only) | board estimation field via existing `estimateMode` discovery | ✅ exists |
| Per-person load | Σ subtask `originalEstimateSeconds` per assignee in sprint (+ story's own estimate when no subtasks) | ✅ computed live |
| Sprints incl. future | agile API (next sprint "PW Sprint 8.1" verified — planning targets the future sprint via picker) | ✅ verified |
| Related stories | `issuelinks` (mostly point outside the loaded set → fetch on demand) | ✅ verified |
| Rank | LexoRank (`customfield_10019`) | ✅ verified |
| Descriptions | ADF documents | ✅ verified |

### 10.2 Tempo (capacity + availability) — verified with live token

Tempo REST v4 (`https://api.tempo.io/4/…`, Bearer token / OAuth):

| Endpoint | Verified | Use |
|----------|----------|-----|
| `GET /4/user-schedule/{accountId}?from&to` | ✅ 200, incl. other users | per-day `requiredSeconds` per person — workload scheme, part-time and holidays already resolved (verified: 7.2h/day vs 5.6h/day for different members) |
| `GET /4/teams` + `/4/teams/{id}/members` | ✅ 200 ("IES NG Nexplore", 42 members, commitmentPercent, roles) | rail membership + ordering |
| `GET /4/plans?from&to` | ✅ 200 (44 plans) | pre-planned allocations to subtract from availability |
| `/4/workload-schemes`, `/4/holiday-schemes` | 403 with member token | not needed — user-schedule is the resolved product |

**Capacity formula (v1):**
`capacity(person, sprint) = Σ requiredSeconds(user-schedule, sprint dates) − Σ plannedSeconds(plans overlapping sprint, non-issue items)`.
Fallback when Tempo is absent/unauthorized: per-board config (hours/person/sprint +
per-person overrides), as before.

**Integration**: new optional Tempo connection on the project integrations surface
(doc 04/11 pattern). Auth: API token (v1) and/or Tempo OAuth 2.0 app — redirect URI
follows the app's existing convention `${origin}/oauth/callback`
(`t3work-useAtlassianOAuth.ts`), e.g. `http://localhost:5173/oauth/callback` for dev
and the production web origin equivalent. Tokens live server-side with the other
integration credentials; never in client code.

### 10.3 Real-data findings (PW Sprint 7.6 fed into the prototype)

1. **The sprint is subtask-shaped** (74/100 items are subtasks; 61 with parents
   outside the sprint) → context-parent ghost frames; subtask-level load and
   assignment; this finding ultimately drove the subtask-primary model (§3.3).
2. **Epic fan-out is wide and shallow** (21 epics / 46 stories, clusters 1–8) →
   extent-aware masonry + affinity ordering (§4) + label decluttering.
3. **Stories are barely estimated; subtasks carry the truth** → aggregate-based
   planning state (§3.6).
4. **18 active assignees** → scrolling rail is the norm.
5. **Long German titles (≤133 chars) + emoji in epic names** → clamps + tooltips fine.
6. **Subtask counts up to 6+ per story** → grid (2-col) inside frames shows all;
   vertical capped lists were rejected.
7. **Related links point outside the loaded set** → fetch-on-demand chips.
8. **Late sprints are ~50% done** → done-dimming; planning targets the next sprint
   (sprint picker defaulting to the future sprint).
9. **Attachment/PR metadata not in backlog payload** → lazy per-ticket fetch on focus.

Rendering conventions adopted from existing surfaces: mono keys, truncate/line-clamp,
`JiraIssueTypeIcon`, estimate presentation helpers, planning-state variants,
context-only tone. Deliberate divergence: avatar initials + color as primary identity
(existing surfaces are text-only; docks/drag require avatars).

## 11. Delivery plan

1. **P1 — Scene spike (read-only)**: scene graph + projection + masonry modules with
   unit tests (disjointness, zoom exactness, fit-all), renderer + bands + groupings
   behind a flag, real backlog data, Tempo capacity read. Exit: fly around the real
   sprint at 60fps with correct capacity rings.
2. **P2 — Planning interactions**: subtask + story drags, assign mode, spotlight +
   filter bar, sprint zones, subtask hour steppers, optimistic write-back.
3. **P3 — Panels + planet + chat**: story/subtask panels, band-5 planet with ADF,
   navigation, subtask create/edit, add-to-chat, agent context contract.
4. **P4 — Live + polish**: diff animations, attention, grouping pivot, snap,
   theater/fullscreen, keyboard support.
5. **P5 — Consolidation**: remove `hierarchy`/`planning`/`ownership` view modes,
   migrate persisted `viewMode`, drop the flag.

## 12. Open questions

- Sprint target line: board velocity vs. Σ Tempo capacity of the team (now derivable!) — probably the latter.
- Multi-sprint boards: sprint picker (likely) vs. multiple zones.
- Issue link types: render all as "related" with type badge, or configured subset?
- Tempo plans: which plan categories count as unavailability (vacation vs. project allocations)?
- Performance threshold for gating band 0–1 to aggregated dots.

## 13. Rejected alternatives (iteration learnings)

- CSS 3D layers instead of manual projection — edges across planes intractable.
- Constant-Δz wheel zoom — wrong perceptual speed at both ends.
- Center-anchored zoom — loses the target; cursor-anchored won.
- **Zoom-coupled layout spread ("make room")** — node targets moved during zoom,
  making cursor-anchored zoom careen uncontrollably; true-size masonry won.
- **Story-level estimate steppers** — estimates belong to subtasks in this process.
- **Checkbox/done-state subtask UI** — planning space plans new work; hours-first won.
- **Capped vertical subtask lists** — subtasks are the planning unit; the all-visible
  grid won.
- Fixed-grid cluster anchors — real cluster size variance (1–8) demands extent-aware packing.
- **Fit-to-bounds "All" with depth-scaled labels** — unreadably small; the epic
  overview is a discrete projection with fixed-size readable tiles instead.
- Free-floating subtask satellites; subtasks-as-dots-until-deep-zoom; camera dolly on
  click; panel at band 5; duplicated owners; force layouts; centered rail handle;
  uncapped text scaling; navigation targets computed at current-zoom spread — all
  rejected in earlier rounds (see git history of this doc for details).

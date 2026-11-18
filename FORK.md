# nckrtl fork of T3 Code

This is Nick's fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
at [nckrtl/conn](https://github.com/nckrtl/conn), shipped as Conn. Read this
file before you merge upstream, build, or change shared UI. Upstream's
`AGENTS.md` applies to everything else.

## Branch and build

- `main` is the only long-lived development branch. It holds every
  customization, and new work lands there directly. Until 2026-10-11 this line
  was the `nckrtl` branch of `nckrtl/t3code`. That branch and the old
  `upstream-mirror` and `rooms-patches*` branches were deleted on 2026-10-15.
  `wip/*` branches hold unreviewed saved work.
- Conn tracks upstream `main`. The Grok bot runs a nightly sync to keep each
  merge small; manual syncs follow the same procedure below. Merge
  `upstream/main` into a `sync/<yyyy-mm-dd>` branch off `main`, then merge it
  back after a good build. Do not merge upstream's preview or stable tags. They
  are cut on release branches, so the next sync from upstream `main` merges
  their cherry-picks again. Never force-push `main`.
- The Mac desktop app, iPhone app and T3 servers (beast, mini, shark and the
  headless server on nick) use Conn builds from `main`. Build server runtimes
  with `scripts/build-cli-archive.ts`.
- Build, sign and install with the [build guide][build]. Builds ship no update
  feed (`publish: null` in `scripts/build-desktop-artifact.ts`), so the app
  never replaces itself with an upstream release. Build and sign the Mac app
  on Nick's MacBook; `scripts/sign-macos-local.ts` re-signs it with the
  Developer ID of team 9SVJ4SYB9B (not notarized). iOS builds run in nick-vm
  and are signed on the MacBook. Packaging and that
  re-sign preflight fail closed unless the full 40-character source SHA is the
  tip of an `origin` `refs/heads/sync/*` branch. Publish HEAD with
  `node scripts/publish-sync-branch.ts`, then verify with
  `node scripts/check-sync-provenance.ts`. Neither command force-pushes or
  bypasses hooks. Nightly or install wrappers outside this repo are not
  covered unless they call those scripts (or the packaging/sign entrypoints)
  before copying a bundle into `/Applications`.

## Upstream scope

Conn ships to three targets (Nick, 2026-11-16). The nightly sync follows upstream only for
what serves them.

| Target      | Platform        | Built from                                                                                                                       |
| ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Desktop app | macOS           | `apps/desktop`, `apps/web`                                                                                                       |
| iPhone app  | iOS             | `apps/mobile`                                                                                                                    |
| Servers     | Linux and macOS | `apps/server`, the T3 server on Nick's machines; `apps/conn-server`, the Conn Server, on Linux in Orbit containers (macOS later) |

Out of scope: Windows, Android and the Linux desktop app (AppImage, deb, AUR), the hosted web
app (app.t3.codes and its previews), the T3 Connect relay (`infra/relay`), and the marketing
site (`apps/marketing`). Only GitHub is used as a source-control host: GitLab, Forgejo,
Bitbucket, Azure DevOps, GitCafe and Cursor origin are out of scope. For the Conn Server, also
every area that `apps/conn-server/docs/orbit-profile.md` rates "not needed".

Ports follow the same scope. The GUI must work properly on macOS and iOS only, and the Conn
Server runs on Linux only. When leaving out another platform or host makes a port clearly
simpler, leave it out and name it in the sync notes or the PR.

Keep the upstream-only workflows listed under [Pull request runners](#pull-request-runners).
Their entry jobs, or their callers for reusable workflows, skip this fork. On a sync, take
upstream's version and keep those repository checks. Deleting them would cause repeated
modify/delete conflicts (Nick, 2026-11-16).

How the sync applies it:

1. **Merge everything, build only what we ship.** The sync still merges `upstream/main` whole.
   Picking commits would make every later merge harder. Out-of-scope code comes in, but
   nothing builds, tests or fixes it.
2. **Out of scope never holds a sync.** A conflict only in out-of-scope code takes upstream's
   side. A build or test failure only there is noted in the sync notes and left alone.
3. **In scope holds a sync, as before.** That covers the desktop and iPhone builds, the T3
   server, and the Conn Server's checks.
4. **The sync notes say what was skipped.** Each sync lists the out-of-scope areas its
   upstream range touched, in one line per area, in the `FORK.md` sync notes.

## Conn Server

`apps/conn-server` is the Conn Server: our own Rust server behind the T3 client contract. It
came in with its history from `hardimpactdev/conn-server` on 2026-11-15. Its own `AGENTS.md`
and `README.md` apply there. It is not a pnpm workspace package, and Conn's builds, desktop
and mobile apps do not use it. Its tools read the contract, the web client and `apps/server`
from this tree.

- **Checks.** Pull requests and `main`/`sync/**` pushes share each workflow's path filter.
  `conn-server-ci.yml` checks changes to `apps/conn-server` or its workflow;
  `conn-server-checks.yml` also checks `apps/server`, `apps/web` and `packages`.
- **The nightly sync follows it** (Nick, 2026-11-16; this replaces the 2026-11-15 skip). On
  its `sync/*` branch, after the merge, the sync runs `apps/conn-server/tools/follow-conn.sh
  --capture`. It ports the upstream server changes in scope, as the T3 server makes them:
  the areas `docs/orbit-profile.md` rates needed or useful. ForkBot does this port. It regenerates what is
  generated, and every triggered Conn Server workflow must pass on the sync branch before the merge.
  An in-scope change that cannot be ported that night becomes a known difference with its
  reason, in the check's known list and in `apps/conn-server/docs/status.md`. A check is never
  weakened to pass. An out-of-scope change needs no port; if it turns a check red, the fix
  is to the check's scope, with the reason. `apps/conn-server/docs/upkeep.md` has the steps.
- **Release.** A tag `conn-server-v<version>` (the `conn-server` crate's version) runs
  `conn-server-release.yml`. It makes a GitHub Release on `nckrtl/conn` with
  `conn-server-<version>-linux-x64.tar.gz` and its `.sha256`, not marked Latest; Orbit
  downloads it. Conn's `release.yml` takes only `v*.*.*` tags, so neither starts the other.
- **Exclusions.** Root Vite+ format, lint and test configs ignore `apps/conn-server/**`,
  `.github/scripts/ci-changes.cjs` treats it and the `conn-server-*` workflows as inert for
  Conn's CI, and `.gitignore` re-includes `apps/conn-server/helpers/sdk-host/build/`. On a
  sync, keep these lines.

## What the fork changes

Paths below are relative to the repository root unless a source list gives
another base directory.

### Shell design

The shell follows ChatGPT's desktop window structure in the active theme's
colors: inset cards, two-tone dividers, glass popovers, toolbar groups, soft
fields, inset scrollbars and a 44px header. This covers chat, sidebar, Settings,
browser, Files, Diff, terminal, Agents and fork panels.

The macOS window is frosted glass. `DesktopWindow.ts` creates it with
`vibrancy: "under-window"`, `visualEffectState: "followWindow"` and a clear
`#00000000` background, and `syncWindowAppearance` keeps that clear background
when the appearance changes. The `html.electron-macos` block at the end of
`index.css` makes the page transparent and tints the frame (`--shell-fill`) and
inner cards (`--shell-inner-fill`) over the native material. The CSS alone shows
no glass; without the window options the frame is opaque.

The thread sidebar is an inset card, like the chat and right panels. In
`Sidebar.tsx`, `SidebarContent` sits inside a `div` with `shell-inner-panel`
(rounded on the left, `mb-(--shell-inset)`), and that card ends with
`<SidebarChromeFooter utilities={false} />`. The workspace rail holds the update
button and the settings, source control and usage actions, so the sidebar
footer must not show them again. Without the wrapper the sidebar loses its
darker card; with the default footer a second row of utility icons appears
under the thread list.

The sidebar header (`SidebarChromeHeader` in `SidebarChrome.tsx`) shows no
brand and no back and forward buttons. Upstream added those buttons in #27430;
Conn keeps the history shortcuts and trackpad swipes but drops the buttons,
which otherwise show beside the traffic lights behind the sidebar card.

Browser pages meet the address bar's bottom divider. Keep `PreviewChromeRow`'s
zero bottom margin. Do not add a Conn override for the inline-panel subheader
(`[data-surface-subheader]` under `[data-right-panel-surface-content]`): it
removes the space above the panel toolbar controls.

Settings and Usage are upstream's route modals (`_chat.settings.*`, `_chat.usage`
over the thread view through `mainAppLocation`). Conn keeps upstream's modal
behavior and draws the shell inside it: `AppRouteModal` is the frosted frame,
`AppRouteModalHeader` the transparent 44px header, `AppRouteModalCard` the inset
card, and `APP_ROUTE_MODAL_NAV_CLASS` the inset Settings nav beside the card.
On a conflict there, take upstream's routing and dismissal logic and keep these
four pieces. The modal floats over the app, not over the desktop: its frame uses
`--shell-modal-fill` (94%, which `html.electron-macos` does not thin like
`--shell-fill`), and its backdrop is `DialogBackdrop variant="app"`
(`app-modal-backdrop`: 80% `--background` and the glass blur), so a bright
browser page behind it neither tints the frame nor stays readable. Small dialogs
and the palette keep the lighter `dialog-backdrop`.

The terminal's actions float in a `ToolbarGroup` over its top right corner, and
the dark chat composer is a step lighter than the chat card (`--shell-composer`).

The [nckrtl-shell-design skill][shell] has the full rules.

Sources:

- Web (`apps/web/src/`): `index.css` (shell tokens at the end),
  `components/ui/*` variants, `components/ToolbarGroup.tsx`,
  `components/ThreadTerminalDrawer.tsx`, `components/chat/ComposerSurface.tsx`,
  `components/settings/*`, `components/AppRouteModal.tsx`,
  `routes/_chat.settings.tsx`, `components/ChatView.tsx`,
  `components/RightPanelTabs.tsx`, `components/Sidebar.tsx`,
  `components/sidebar/SidebarChrome.tsx`, `lib/windowControlsOverlay.ts`
  (`electron-macos`), `navigationHistory.ts` (no button hook), `routes/__root.tsx`, `pierre-tree-theme.ts`.
- Desktop traffic lights and window glass:
  `apps/desktop/src/window/DesktopWindow.ts`.
- Guards: `apps/desktop/src/window/DesktopWindow.test.ts` (window glass) and
  `apps/web/src/components/sidebar/connShellSidebar.test.ts` (sidebar card and
  footer).

### Icons

Web thread timeline icons are Phosphor: solid by default, bold for carets and
line glyphs whose solid form adds a box. Icons elsewhere stay Lucide.
`ConnIconScope` around `MessagesTimeline` in `ChatView.tsx` selects Phosphor.

The web tsconfig and Vite's `resolve.alias` map `lucide-react` and `lucide` to
Conn modules that pair each Lucide icon with a Phosphor icon. Upstream imports
stay unchanged. A new upstream icon fails typecheck until it gets an entry. Both
mappings are needed: the dev server ignores tsconfig paths for pre-bundled
packages.

Upstream removed icon morphing and `MorphIcon` (#33985); the 2026-11-12 sync took
that removal, so toggles swap icons instantly through `lucide-react`. The `lucide`
alias and `lucideNodes` (from `lucide-original`) remain for any `lucide` import. Project and workspace icons use
`lucide-react/dynamic` and `lucide-react-original`.

Sources:

- Web (`apps/web/`): `src/icons/` (`lucide-react.ts`, `lucide.ts`,
  `connIcon.tsx`), `tsconfig.json` (`paths`), `vite.config.ts`.
- Components (`apps/web/src/components/`): `ChatView.tsx`,
  `sidebar/workspaceVisuals.tsx`.

### iOS icons

On iOS, thread feed icons in messages and the work log are Phosphor. The rest of
the app, including native toolbars, tab bars and menus, keeps SF Symbols.
Android keeps Tabler. `AppSymbol.tsx` (upstream's iOS implementation since its platform-primitive
refactor, #33173; Conn's version replaces it) also uses SF Symbols for git icons
that upstream drew with Tabler.

`symbols.json` maps SF names to Phosphor icons and weights: solid by default,
bold for carets and line glyphs that solid would box. Inside `ConnSymbolScope`
around `ThreadFeed` in `ThreadDetailScreen.tsx`, `AppSymbol.tsx` requests
mapped names with a `conn.` prefix. `ConnSymbols.swift` swaps `UIImage`'s
`systemImageNamed` methods only for those names.

After changing `symbols.json`, run `node scripts/build-conn-symbols.ts`. It
builds custom symbols and `ConnSymbolNames.swift`. Commit the output and rebuild
the app.

Sources:

- `apps/mobile/modules/conn-symbols/` (`symbols.json`, `ios/`).
- `scripts/build-conn-symbols.ts`.
- Mobile (`apps/mobile/src/`): `components/ui/AppSymbol.tsx`,
  `components/ConnSymbolScope.tsx`, `features/threads/ThreadDetailScreen.tsx`.

### Workspaces

A workspace rail sits beside the thread sidebar. Workspaces have their own
projects, icons and extra windows. New threads stay in the selected workspace.

The rail alone does not provide workspace isolation. `Sidebar.tsx` must publish
the available projects to `useWorkspaceStore`, intersect the project filter
with the active workspace, and reset row selection and the settled tail on a
workspace change. `WorkspaceDialog` reads that project registry. On mobile,
`HomeScreen.tsx` and `ThreadNavigationSidebar.tsx` must pass
`selectedWorkspaceProjectRefs` into the thread list when no narrower project
is selected. Preserve these consumers when upstream moves the list or filter
UI. See the [November 8 audit](#upstream-sync-audit-2026-11-08) for the restored consumers.

Upstream has one desktop window, so upstream code often assumes a single main
window. In the fork every window must behave the same. `DesktopWindow.ts`
registers each window with `PreviewManager.addWindow`, and the preview manager
accepts browser guests hosted by any of them. When an upstream sync adds code
that reads a main window, make it work in workspace windows too, or the browser
panel and its tools break there.

Sources:

- Web: `apps/web/src/workspace*.ts`; under `apps/web/src/components/sidebar/`,
  `WorkspaceRail.tsx` and `WorkspaceDialog.tsx`.
- Desktop windows and IPC: `apps/desktop/src/`.

### Desktop control socket and links

The desktop control socket accepts `open-thread` and `select-workspace`.
Workspace links use `t3code://workspace/...` or `conn://workspace/...`. Rooms
tooling uses these entry points.

The socket also starts when the local environment is disabled, through
`DesktopApp.ts` bootstrap. Upstream starts it only after the local backend.

Sources:

- `apps/desktop/src/ipc/*`, `apps/desktop/src/app/DesktopApp.ts`,
  `packages/contracts/src/desktopAppActivation.ts`.

### Orbit

Orbit in Conn means container Instances: Conn pairs with the servers the Gateway lists, shows
them, and starts threads in a Project's Instance container. Conn no longer makes worktree-based
Instances. Old ones and their threads are settled in Orbit; Conn keeps showing such a thread as a
plain worktree thread and never removes it.

Orbit's configuration lives in the Orbit panel, not in Settings, so Settings stays close to
upstream. Settings › Environments (`ConnectionsSettings.tsx`) keeps only the fork's
"Environments from" row (`EnvironmentProviderSection`); in Orbit mode it hides the
Environments list and keeps the per-environment Linked environments, Load balancing and
GitHub routing sections. Reading linked
environments needs `access:read` on that server; answering a link card needs
`access:write`.

The Gateway requests T3's administrative scopes for device pairing links (Orbit
commit `d17002d`). If a saved Orbit server's session lacks `access:write`, Conn
pairs it again at most once every 6 hours. The shared `lacksAccess` and
`accessPairedAt` logic is wired into the web and mobile Orbit providers.

The environment sync lists every server on the Gateway but pairs only host servers (no
`instance_id`) by itself. A clone, an Instance's server, pairs only when a thread starts in it on
this device (a new Instance or an existing one). Without this every device paired with every new
clone within minutes. The desktop has no manual Connect; the phone's Connect button is retried by
the sync, with the usual back-off, until the app restarts. Pairings made before this rule stay;
nothing revokes them. `planEnvironmentProvider` takes the phone's requested ids; web and mobile
share one pairing step (`pairOne`), and a second call for a server joins the one in flight.

A saved Instance server that two successful, non-empty Gateway lists in a row leave out, at
least `GONE_CONFIRM_MS` (2 min) apart, is removed from the device (`plan.remove`): its Instance is gone, and Orbit may give its address to a
new Instance. Web removes it as the Orbit panel removes an Instance (catalog, pairing records,
Orbit facts, thread starts); mobile removes the catalog entry and the pairing records. A server
counts as an Instance's when a list showed it with an `instance_id` (`instanceServers`, also the
web's remembered clone ids). Two lists and a minimum time, because only an explicit Connect pairs a
removed clone again, and a profile edit runs a second sync within seconds. A failed read or an
empty list removes nothing; host servers only switch off; a clone a thread start holds stays.
Losing access to a Node, or another Gateway, removes its clones the same way.

An old worktree-based Instance's checkout sits beside the Project's `default` checkout
(`<apps>/<project>/t3code-<8 hex>`, older ones `t3-<8 hex>`). `isOrbitCheckout`
(`apps/web/src/orbit/orbitCheckout.ts`) recognizes that path, so deleting such a thread never
offers to remove the worktree; Orbit owns it. Folders under `<T3 home>/worktrees/<repo>/` or a
`.t3` folder are T3's own and never match; an Orbit apps path named `worktrees` or inside `.t3`
would be missed.

In the desktop app in Orbit mode, New thread starts threads in Orbit Projects; there is no other
switch and no other entry (Orbit's `docs/cli/instance/container/thread.mmd`). Outside Orbit mode,
and in the web app, the palette and composer are unchanged.

**Project rows.** The New thread palette lists the Projects of `GET /api/v1/conn/projects` after
the local projects, asked with `include_unavailable=1` (Orbit lists only startable Projects without
it; the phone does not ask). Each row shows the number of the Project's Instances in the Gateway's
environment list (the default never counts), and the clone rows of those Projects leave the list.
While the list loads or after it fails, only local projects show, then skeleton rows or a notice
with Retry. A Project that is also a normal Conn project shows as two rows. A Project in which
threads cannot start yet (`cloneable: false`) stays selectable, greyed out with its failing check's
message. The parser tolerates missing `cloneable`, `cloneable_reason`, `checks` and
`instance_domain_suffix`; a row without `cloneable` can start threads.

**Checks page.** A greyed row opens its start checks (`CommandPaletteOrbitChecksPage.tsx`): Orbit's
five checks in order with Conn's own labels, one more row for any other failing check (Orbit's
`label`), and "Check again", which re-reads the list and keeps the last result when the Gateway
does not answer. Only the latest check's answer counts. Once threads can start there, it offers the
Instance step.

**Instance step.** A startable row opens the Instance step (`CommandPaletteOrbitInstanceStep.tsx`,
`orbitInstanceStepLogic.ts`): a name field with the Project's domain suffix, checked live with
`GET /api/v1/conn/projects/{id}/instances/check?name=` after the local name rule passes. Reason
`domain_invalid` (the address `<name>.<project domain>` breaks Orbit's limits; Conn hard-codes no
length) reads "This name makes the address too long. Use a shorter name." A failed
or slow check keeps create possible (Orbit's `instance.name_taken` at create is the guard); 409
`instance.default_missing` blocks it. A search that finds no Instance fills the field with the
search text as a slug, unless the user typed a name. "Existing instances" lists every Instance of
the Project in the Gateway's environment list (no owner filter, never the default); stopped and
expired ones are disabled. A paired one opens a normal draft in its `/srv/workspace` project, an
unpaired one an Orbit draft. The desktop IPC lets only these queries through (with the branch
search below).

**Orbit draft.** The composer draft carries an Orbit target (`orbitDraft.ts`, `openOrbitDraft`):
the Project, Node, and a new Instance with the typed name or an existing one this device has not
paired. An Orbit Project is no T3 project, so the draft uses a placeholder project id and is
anchored on a paired clone of the same Project, else the primary environment, for its model list.
The context row shows the Node and `<instance> · <project>`, which reopens the Instance step;
attachments are off. Send saves a start (typed name, model and modes) for the runner instead of
sending through a T3 server, opens its pending thread, then clears the draft. This is not the
older worktree env mode `"orbit"`.

**Branch control** (`orbitBranchControl.ts`). A new Instance's context row shows "From <default>" (no choice: the create
sends no `branch`); the draft reads the name once per Project per session and shows "From default
branch" until it is known or when the read fails, never a guessed `main`; and a menu from `GET /api/v1/conn/projects/{id}/branches?query=` (25 s limit)
with two modes, "New branch from" and "Work on branch". Under "Work on branch" the default branch
is disabled, and a branch another Instance works on selects that Instance instead; for a paired
Instance a typed prompt moves into its draft with attachments, modes and a picked model. Admission
refusals (`branch.in_use`, `branch.not_found`, `branch.exists`, `instance.placement_conflict`,
`source.head_unavailable`) made no Instance and offer Change branch or Change name; the create
step codes keep Retry only. Retry resends the same choice. The ready card shows Branch and Base,
and says dependencies come from the default branch when the code is not that branch.

**Pending thread and setup card.** The pending thread at `/orbit/$startId`
(`OrbitPendingThreadView.tsx`) shows the message and a setup card built on the client from the
saved start and the runner's reads of the create Operation (`orbitSetupView.ts`), since the clone's
server does not exist yet. The worktree setup contract is untouched. A pending start also shows as
a sidebar row (`OrbitPendingThreadList.tsx`) and survives a reload. While "Create Instance" runs it
shows five rows of Orbit's create steps (`orbitCreateRows.ts`: Orbit's step `group` when sent, else
the step name; an unknown step stays with the row that ran). Orbit fills step times only once the
Operation ended, so each row is timed from when the runner first saw it change, saved in the
start's `createRows`, and Orbit's times replace those at the end. The running card has Details and
Cancel; Cancel asks Orbit to cancel an admitted create (`POST /operations/{id}/cancel`), then
drops the start; an admitted Instance stays. A Cancel after the create was sent but before Orbit
answered, in any window, marks the start (`cancelRequested`, hidden from the sidebar); the main
window's runner repeats the admission under the same key, cancels the Operation and drops the
start, or keeps it as failed when the cancel fails. A start with no create sent is dropped at once.

**Runner.** `OrbitThreadStartRunner`, mounted once in the main window's root route, runs every
saved start (`orbitThreadStarts.ts` on the shared `runOrbitThreadStart`): Orbit creates a clone of
the Project's default Instance (or the start uses the picked one), Conn pairs with the clone's T3
server once, and sends the first message in its `/srv/workspace` project (`sendOrbitFirstMessage`).
Each start is saved in localStorage after every step, with a fixed launch command id, so a reload
resumes it and a repeated launch finishes the first one. The Gateway admits a create or a pairing
only after it copies secrets to Swamp (19-27 s), so those two calls get a 60 s limit instead of
the desktop's 15 s default, and carry a saved `Idempotency-Key`. A lost answer (none, or a proxy's
502 or 504 without the Gateway's error envelope) repeats the same request with a clamped back-off,
so the Gateway returns the Operation it may already have admitted. A create refused with 409
`operation.target_busy` (another Operation owns the Instance) repeats the same way until the
create's deadline, then stops with "press Retry in a minute"; the pairing admission takes no
target lock, so it cannot be busy. Any other Gateway error stops the start. The environment sync
skips a clone a start is pairing with (`heldOrbitInstanceIds`), and an asleep one. Away from the
pending thread, a toast reports the result. Starts saved by the removed sidebar dialog load as
pending threads, so they resume or can be dismissed; one whose send finished is dropped.

**Workspaces.** A start saves the workspace selected at Start (null for all). Once the first
message is sent, that workspace gets the clone's `<environmentId>:<projectId>` ref unless it
already lists the project or no longer exists, so the sidebar shows the thread (a clone is a new
environment). The profile sync then drops the refs of clones that are gone
(`cloneWorkspaceRefs.ts`). A gone record no longer says it was a clone, so each device remembers
the clone ids it saw in the Gateway list (with an `instance_id`), and drops only refs of those ids
that a later fresh, non-empty list in Orbit mode leaves out. A clone gone before any list showed it
keeps its ref. Host and manual environments' refs are never touched.

**Handover.** Once the clone's server took the first message and the thread reached the window,
the pending route is replaced by the real thread. The start stays saved after the send (the newest
50), so the real thread finds it by thread id and Conn draws "Instance ready", its Details and the
ready line itself; none of it goes to the agent. If the clone lacks the composer's provider, the
first turn uses the clone's default and the ready area says so.

**Failures.** A failed start offers Retry (from the last saved step), Change name (for refusals
that made no Instance, such as `instance.name_taken` and `route.domain_invalid`; reopens the draft with the message and model, then the Instance step) and
Dismiss, which drops only the saved start on this device; it removes no Instance (the Orbit
panel's Instances page does). A create that failed with `instance.container_process_inactive` (a Project process
did not stay up, named by `result.process_failure.unit`) offers Retry on the desktop and the phone
only when the Operation's `result.recovery.requires` is `project_process_definition`: Orbit then
retries with the Project's current process definitions, and the card says to change or remove the
process first. Without it (older Gateways) the kept Instance keeps the broken process, so the card
offers no Retry and says to remove the Instance and create it again.

Still waiting for Orbit: the Node menu ("Run on") and
starting a stopped Instance (stopped Instances stay disabled).

The phone starts the same thread from Choose project › Orbit project in Orbit mode. Its Instance
name comes from the message (`orbitThreadInstanceName`, saved with `nameSuffix`); before each new
create the runner checks it and, while Orbit answers `domain_invalid`, tries the slug cut to 24,
then 12, then `thread`, keeping the suffix. When none fits, or a check fails after such an answer,
the start stops with `route.domain_invalid` instead of creating. It runs the
shared state machine and first-message launch (`threadStart.ts`, `threadTurn.ts`); the starts
live in `orbit-thread-starts.json` in the app's documents folder. The file write is async, so
each Gateway call, the pairing and the send first wait for it; a failed write stops the start. Start rows with the stage, Retry and Dismiss sit above the
thread list. The thread opens once sent if the screen the start returned to still shows. The phone's workspaces are the
profile's, so a sent start adds the clone's ref to the workspace selected at Start in the
profile itself (one re-read on a version conflict).

On a clone thread the Laravel toolbar's Orbit tool calls the Gateway from the desktop main
process, with writes limited to the clone's own Instance; see [Laravel Toolbar](#laravel-toolbar).

The thread panel's machine row becomes the Orbit row for a server in an Orbit Instance:
Project, Instance and Node, and the URL as a link (`ThreadDetailsOrbitRows.tsx`). Clones run
the stock T3 server, so the Gateway's environment record is their source: in Orbit mode each
clone record of `GET /api/v1/conn/environments` carries `project_id`, `project_name`,
`project_slug`, `instance_name`, `node_name` and `instance_url` next to `instance_id`
(`orbitInstanceFromEnvironment`; both ids or no facts, missing or mistyped fields read as
null). The desktop keeps the last list's facts in localStorage, so the row shows right after
start (`useOrbitInstance`). The same URL is where the thread's API panel starts
(`useOrbitInstance(...)?.url` in `ChatView.tsx`). The phone has no thread details panel like the desktop's, so it shows none of this; its
thread lists keep the environment label.

The fallback, for a fork server outside Orbit mode: the server reads `/etc/orbit/instance` at
start (`apps/server/src/orbit/OrbitInstanceFile.ts`). Orbit writes it: `KEY=value` lines, `#`
comments, unquoted values. Conn reads `ORBIT_PROJECT_ID`, `ORBIT_INSTANCE_ID`,
`ORBIT_PROJECT` (slug), `ORBIT_PROJECT_NAME`, `ORBIT_INSTANCE`, `ORBIT_NODE` and `ORBIT_URL`,
and ignores other keys. With both ids as positive integers, the environment descriptor gets
`orbitInstance` with the facts; otherwise it has none, and a missing or unreadable file never
stops the server. Old clones without `ORBIT_PROJECT_ID` have no descriptor. The sidebar title of the clone's
`/srv/workspace` project comes from Orbit, which adds it with `t3 project add --title`.

The Orbit panel is a modal like Settings, with its own nav: Instances, Connection and Profile
(the profile this device follows). Instances lists every Instance this device can reach, by Orbit Project,
never a default: today from the Gateway's environments named from its Projects, later from Orbit's
flat `GET /conn/instances`. Only `listOrbitInstances` in `client-runtime/src/orbitGateway/instanceList.ts`
reads the source; grouping, search, the Project filter and the join with local threads beside it
are pure, so mobile reuses them. "New thread in this Instance" does what the palette's Instance
step does (`openOrbitInstanceById`). The bin button removes an Instance through
`POST /conn/instances/{id}/destroy` (`removeOrbitInstance`, one `Idempotency-Key` per attempt) and
follows its `instance.destroy` Operation; any 404 counts as already removed. The list carries no
Git state yet, so the first request goes without `acknowledge_unsaved`, and Orbit's 409
`instance.unsaved_work` (always `state: "unknown"` for now) makes the dialog ask for the tick. Every
other refusal (a default or checkout Instance, a busy one, …) stays on the row with Orbit's message
and Retry. After a remove, `cleanUpRemovedOrbitInstance` drops the saved starts, pairings, servers
and their threads. The phone has no remove yet. Conn picks up the Orbit connection from the
machine (tunnel, root CA and Node are set up outside Conn), so Connection has no Gateway address
field and no set-up flow. It shows this device's Node name and WireGuard address with Reload,
three checks read from one `me` call (Gateway reachable, certificate trusted, device known), the
Nodes that run a T3 server (host servers only; Instance servers never show here) and a link back
to "Environments from". The desktop transport passes Chromium's `net::ERR_*` text on, which is how
a TLS failure is told from a connection failure; `orbitConnectionChecks` and `orbitNodeServers`
(`packages/client-runtime/src/orbitGateway/orbitConnection.ts`) map them for web and, later,
mobile. A check after a failed one shows "Not checked". An Orbit icon above Settings in the
workspace rail opens the panel on Instances; it shows only in
the desktop app with "Environments from" set to Orbit, and the panel closes when that changes.
A profile sync that drops the selected workspace leaves the panel open, as it does Settings
(`isAppModalPage`). Settings search has no entries for the panel's sections.

Sources:

- `apps/web/src/orbit/*`.
- Orbit panel: `apps/web/src/components/OrbitPanel.tsx`, `OrbitInstancesPage.tsx`,
  `orbit/orbitPanelPages.ts`, `orbit/orbitInstanceList.ts`,
  `routes/_chat._orbitPanel*.tsx`, the rail button in `components/sidebar/WorkspaceRail.tsx`,
  `components/sidebar/mainAppLocation.ts` (`isAppModalPage`).
- Settings files the fork touches for Orbit: `components/settings/OrbitSettings.tsx` (the
  panel pages and `EnvironmentProviderSection`), `components/settings/ConnectionsSettings.tsx`
  (the "Environments from" row only), `components/settings/settingsSearch.ts`
  (`environment-provider`).
- `packages/client-runtime/src/orbitGateway/environmentProvider.ts`.
- `packages/client-runtime/src/orbitGateway/threadStart.ts` and `threadTurn.ts`.
- Mobile (`apps/mobile/src/features/orbit/`): `orbitThreadStart*.ts`, `orbitThreadStarts.ts`,
  `orbitWorkspaceRef.ts`, `OrbitThreadStartScreen.tsx`, `OrbitThreadStartRows.tsx`.

### Orbit profile sync

The desktop app saves workspaces in the device's Orbit profile on the Gateway
(`/api/v1/conn`), so phones and other desktops share them. Edits merge on a
version conflict. Manual environments still work.

The profile also carries:

- Appearance: light and dark theme slots, full palettes for custom and published
  themes, mode, contrast and the custom theme library.
- Settings per device type. `devices.desktop` holds fonts, sizes, chat width,
  glass, motion, diffs and timestamps.

Conn writes each section with `PATCH /profiles/{id}/settings`. Version conflicts
merge per key or theme. A profile is one set of settings: every part always syncs, and
nothing can be switched off, forced or restored per device. The first sync with a profile,
also after a switch in the Orbit panel › Profile, adopts the profile or seeds an empty one,
with no confirmation; a switch first sends this device's unsent edits to the profile it
leaves (`switchOrbitProfile`). "New profile…" in the profile menu makes a profile from
this device.

An environment's `t3 theme set` is not a user choice and never syncs.
`orbit/themeOrigin.ts` wraps both calls in `useDefaultTheme.ts`. Themes a device
lacks are installed in the "From profile" collection until replaced by the live
published theme. On an older Gateway without sections, workspace sync still
works and Conn shows "Gateway doesn't support profile sync yet".

Keep `patches/@alchemy.run__drizzle@2.0.0-beta.85.patch` in
`patchedDependencies` while the catalog pins that version. drizzle-kit fails
on an absolute `out`.

The phone adds Settings › Orbit with a profile picker and one-tap pairing for
the Gateway's T3 servers. The thread list has a Workspace filter.

Sources:

- Shared (`packages/client-runtime/src/orbitGateway/`): `profileSync.ts`
  (engine), `sectionMerge.ts`, `profileDocument.ts` and supporting files.
- Web (`apps/web/src/orbit/`): `OrbitProfileSync.tsx`,
  `OrbitAppearanceSync.tsx`, `appearanceProfileSync.ts`,
  `deviceSettingsSync.ts`, `profileSync*.ts`, `themeOrigin.ts`,
  `workspaceProfileSync.ts`.
- Web (`apps/web/src/`): `components/OrbitProfilePage.tsx` (the Orbit panel's Profile
  page; its logic is `orbitGateway/profilePage.ts`), `hooks/useDefaultTheme.ts` (two
  wrapped calls).
- Gateway PATCH IPC: `apps/desktop/src/ipc/methods/orbitGateway.ts`,
  `packages/contracts/src/ipc.ts` (`orbitGatewaySend`).
- Mobile (`apps/mobile/src/`): `features/orbit/*`,
  `features/home/home-list-filter-menu.ts`, `features/home/HomeHeader*.tsx`,
  `features/home/HomeScreen.tsx`,
  `features/threads/ThreadNavigationSidebar.tsx`.

### Laravel Toolbar

A Laravel debug bar sits under the browser page. It shows requests, timings,
queries, models, PHP, Orbit processes and logs, and dependencies. Its flyout is
a floating sheet portaled to `body`. Apps using php-data-bridge's Symfony
adapter show Symfony's icon, version and environment. Pages with a
Content-Security-Policy get no inline toolbar data; the desktop main process
reads the `x-toolbar` response headers instead.

Preserve the whole browser integration, including its mount points:

1. `preview-pick-preload.ts` imports `LaravelToolbarPreload.ts`. The preload
   reads page data and update events, or the header payload supplied by
   `ResponseHeaderRelay.ts`, and sends `laravel-toolbar` messages to its host.
   The preview manager must install the response listener and attach each guest.
2. `HostedBrowserWebview.tsx` passes those guest messages to
   `relayLaravelToolbarMessage` with the environment-scoped runtime tab ID.
   The relay writes `useLaravelToolbarStore`; a `none` message clears that tab.
3. `components/preview/PreviewView.tsx` renders `BrowserLaravelToolbar` below
   the page area, with the same `runtimeTabId`, `threadRef` and page URL. Mount
   it only for an existing, nonempty tab without a load failure. The component
   renders nothing until data arrives. Keep it outside the page area so its
   height does not cover the page.

Numbers use the toolbar's own format, not the bridge's text. `formatMs` in
`laravelToolbar/model.ts` shows a space before the unit and steps up from
`ms` to `s` to `min` (`245 ms`, `30.2 s`, `2 min 5 s`); `formatCount` groups
thousands. Request rows reformat the bridge's duration (`30168ms`) through
`parseDuration` and sort on `RequestSummary.durationMs`. `model.test.ts`
covers both.

The Orbit tool reaches the Gateway in one of two ways (`BrowserLaravelToolbar.tsx`,
`orbit/desktopOrbitTransport.ts`). For a thread whose environment is an Orbit Instance
(`useOrbitInstance` gives an instance id) the desktop main process sends the calls
(`orbitToolSend`, `apps/desktop/src/ipc/methods/orbitTool.ts`): in a container `curl` goes through
the Node's proxy, which refuses `.orbit` names, and the tool would hide. Other threads, and the
web build, keep the hidden terminal on the thread's server. The page's domain still decides which
Instance the tool shows. The main process sends only these calls, with integer ids, the listed
query keys and no others, and the same `..` and encoded-slash checks as the Conn layer:

- GET `/api/v1/instances/resolve` (`domain`), GET `/api/v1/nodes`, GET `/api/v1/realtime`.
- GET `/api/v1/processes` (`target_type=instance`, `target_id`), GET
  `/api/v1/processes/{id}/logs` (`lines`), POST `/api/v1/processes/{id}/start|stop|restart`.
- GET `/api/v1/instances/{id}/dependencies`, GET `/api/v1/instances/{id}/logs` (`lines`).
- POST `/api/v1/instances/{id}/log-streams`, PUT and DELETE
  `/api/v1/instances/{id}/log-streams/{stream}`.

Reads follow the page. Writes (process actions and log streams) go only to the thread's own
Instance: the main process reads `instance_id` of the request's environment from
`GET /api/v1/conn/environments` (10 s cache) and, for a process action, checks that the Process
is in that Instance's process list. Without an Instance, or for another Instance, it refuses
before the write. The application log's realtime WebSocket opens in the renderer, as before.

The Orbit tool's process status falls back to the Gateway's `status` when
`runtime_status` is `unknown` or missing, as for container Instances. Without a
usable answer it shows `unknown`, never `crashed`, and keeps the process's
actions and log follow. The Processes log pane reads a one-time tail (the
Gateway can take 8 s or more for container Processes) and must always end in a
tail, an empty message, or an error with Retry. A non-followed read is not
repeated, so never swallow its failure.

`ApiPanel.tsx` has a separate toolbar mount. Keeping that mount, the toolbar
directory, or the preload is not enough to preserve the browser toolbar. The
November 7 sync removed the browser mount and the guest attachment in
`Manager.prepareWebview`, while still typechecking. Preserve both the
response-header and dictation attachments, in-page navigation notification,
and guest cleanup when merging upstream preview-manager changes.

Run `PreviewView.browser.test.tsx` as well as the toolbar relay and store tests.
The browser test sends a page payload through the relay, checks that the
Requests control and request details appear, then clears them with `none`.
For an integrated desktop check, open a bridge-enabled Laravel page, inspect
a request, navigate to a non-Laravel page, and check that another tab's data
does not appear. Include a CSP page so the response-header path is exercised.

The native display of server-owned tabs uses the same guest attachment. A
working PHP bridge or API-panel toolbar alone does not prove this path works.
`Manager.test.ts` covers header delivery through the guest preload handler;
`PreviewView.browser.test.tsx` covers the relay-to-toolbar consumer.

Sources:

- `apps/web/src/laravelToolbar/*`.
- `apps/web/src/components/preview/PreviewView.tsx` and
  `PreviewView.browser.test.tsx` in the same directory.
- `apps/web/src/browser/HostedBrowserWebview.tsx`,
  `apps/web/src/api/ApiPanel.tsx`.
- `apps/desktop/src/preview-pick-preload.ts`.
- `apps/web/src/orbit/desktopOrbitTransport.ts`, `apps/desktop/src/ipc/methods/orbitTool.ts`.
- Desktop (`apps/desktop/src/preview/`): `LaravelToolbarPreload.ts`,
  `ResponseHeaderRelay.ts`.
- `packages/shared/src/laravelToolbarHeaders.ts`.

### API panel

The API right panel saves requests per project, with headers, body, response and
a Laravel Toolbar for each request. The desktop main process sends requests
through `apiSend` IPC. This avoids CORS and needs no server change.

Sources:

- Web (`apps/web/src/`): `api/*`, `laravelToolbar/headers.ts`,
  `rightPanelStore.ts`, `components/RightPanelTabs.tsx`,
  `components/ChatView.tsx`.
- `apps/desktop/src/ipc/methods/apiRequest.ts`.
- `packages/contracts/src/ipc.ts` (`apiSend`).

### Database panel

The Database right panel shows the project's database from its `.env`, saved
connections, tables and columns, and a read-only SQL editor. Laravel Toolbar
queries open there through "Open in Database".

The desktop main process connects through `databaseRun` IPC using `mysql2`,
`postgres` or `node:sqlite`. It keeps one connection per database for 5 idle
minutes, so a query costs one round trip. Only reading statements run. MySQL
sessions are read-only. PostgreSQL calls use a pipelined read-only transaction
that is rolled back.

Vault Mac app databases appear under Vault in the connection menu, grouped as
Personal, then by organization. Conn starts Vault's signed relay with
`Vault --conn-bridge`; it accepts only Conn by code signature. Listings contain
no password. Calls fetch credentials and TLS mode from the unlocked Vault. Only
a user action lets a locked Vault ask for Touch ID.

An entry with an SSH host uses this Mac's `ssh`, so `~/.ssh/config` aliases and
`known_hosts` apply. Conn uses Vault's SSH agent, stores no key and closes the
tunnel with the connection. Refresh closes open connections so changed Vault
entries are read again.

When the dev launcher builds its Electron runtime, it signs the binary with the
team's Developer ID as `com.nckrtl.conn.dev`. This lets dev builds use Vault.
Set `CONN_DEV_SIGNING_IDENTITY=-` to keep it ad-hoc.

Sources:

- Web (`apps/web/src/`): `database/*`, `laravelToolbar/model.ts`
  (`inlineBindings`), `laravelToolbar/context.tsx` (`openQuery`),
  `rightPanelStore.ts`, `components/RightPanelTabs.tsx`,
  `components/ChatView.tsx`.
- Desktop (`apps/desktop/src/ipc/methods/`): `database.ts`, `vault.ts`,
  `sshTunnel.ts`.
- `packages/contracts/src/ipc.ts` (`databaseRun`, `vaultDatabases`).
- `apps/desktop/scripts/electron-launcher.mjs`.

### MCP panel

The MCP right panel works like MCP Inspector. It saves servers per project:
stdio commands, Streamable HTTP or SSE URLs. New entries default to the app URL
plus `/mcp`; servers from a project's `.mcp.json` can be added.

The panel offers tools with forms from their input schemas, resources and
templates, prompts, server info, and a JSON-RPC log with stderr. A selected
tool, resource or prompt opens on Overview (description and inputs, so long
descriptions fit) or Playground (inputs beside their labels, the run button on
top, the result below). Results render Markdown and highlight JSON; copy and
raw/formatted actions float over the result, like the terminal's. The desktop
main process holds sessions through `@modelcontextprotocol/client`, using
`mcpConnect`, `mcpRequest` and `mcpDisconnect` IPC with `mcp-event` pushes.
Stdio servers run on this machine with the login shell's PATH.

Sources:

- Web (`apps/web/src/`): `mcp/*`, `api/ApiRequestEditor.tsx` (`HeaderRows`),
  `rightPanelStore.ts`, `components/RightPanelTabs.tsx`,
  `components/ChatView.tsx`.
- `apps/desktop/src/ipc/methods/mcp.ts`.
- `packages/contracts/src/ipc.ts` (`mcpConnect`).

### Browser and device annotations

Browser and Device panel annotations are Conn-native. The Conn server stores
them per project as plain files under `<stateDir>/annotations/<projectId>`. A
thread works through its project's queue. Tap the annotation icon in the
browser toolbar to load the overlay and start annotating; no annotator server
runs. The overlay is ported from `@nckrtl/annotator` into
`packages/annotation-overlay`. Desktop tabs reach the queue through a guest
preload and the hosting renderer; server tabs through a Playwright binding.
Agents use the `annotations_list`, `annotations_claim`,
`annotations_complete` and `annotations_release` MCP tools. Send and Watch
prompt the thread with those tools.

The queue needs visible entry points as well as its store and overlay bridge.
`PreviewView.tsx` passes `BrowserAnnotationControl` to
`PreviewChromeRow.annotationAction`. `DeviceWorkspace.tsx` connects the
annotation target and queue to `DeviceStreamView` and places
`AnnotationQueuePopover` in `DeviceControlsRail`. Upstream's element picker
and dictation UI do not replace Conn's persistent annotation queue. These
entry points were lost in the November 7 sync; see the audit below.

Drift dictation starts from the overlay. On desktop tabs the overlay asks the
guest preload (`window.__ANNOTATOR_HOST__`), and the main process POSTs the
dictation URLs the renderer registered for the tab, so the page never gets
them and its CSP cannot block them. Server tabs POST from the page.

On desktop tabs each box is an Operator caller session named by its draft ID
(`/dictate/start`, `/dictate/stop`, `/dictate/wait` and `/dictate/cancel` with
`{"session"}`). Operator shows the recording, so the box shows no recorder or
timer. Right after the start the box sends `/dictate/wait`, which answers
when the session ends without stopping it: Operator's shortcut, or the next
box's start. Then, or on Enter, the send button or a click on the next
element, the box closes, and its stop's text fills and saves it; empty text
discards it. An Operator without `/dictate/wait` (before 2026-10-28) answers
404, and the box then waits for Enter or a click. An Operator without sessions
records and pastes as before.

Sources:

- Server (`apps/server/src/`): `annotations/AnnotationStore.ts`,
  `mcp/toolkits/annotations/*`, `preview/ServerBrowser.ts`, `ws.ts`.
- `packages/contracts/src/annotations.ts`,
  `packages/shared/src/annotationBridge.ts`, `packages/annotation-overlay`.
- Desktop (`apps/desktop/src/preview/`): `ConnAnnotationsPreload.ts`,
  `AnnotatorHostPreload.ts`, `AnnotatorDictation.ts`.
- Web (`apps/web/src/`): `annotations/*`, `components/device/*`,
  `browser/HostedBrowserWebview.tsx`.

### Desktop tab automation

Agents on trusted environments can drive their thread's open desktop browser
tabs, including tabs the environment did not launch. Tabs register automatically
with no consent step. Stopping the thread or closing a tab ends its automation
session and closes its endpoints.

All preview tools work except recording. Hidden tabs use Electron's native
screenshots. `preview_cdp_endpoint` gives scripts on the tab's host a temporary
loopback endpoint for `chromium.connectOverCDP`. Each endpoint accepts one
connection.

Personal Vault logins remain private, as described under
[Password-manager autofill](#password-manager-autofill). Agents only get Conn's
test logins.

This also holds when the server runs on another machine (Beast, mini, nick-vm).
Only `preview_cdp_endpoint` stays on the tab's host, because it listens on
loopback. Upstream does not have the relay, and its agent copy says desktop
tabs cannot be reached from another machine. On 2026-10-28, a sync brought in
such a `t3_preview_list` description (upstream #24850), and agents on Beast
refused to drive Nick's tabs. In every sync, read upstream's changes to the
preview tool descriptions and agent instructions, and keep or rewrite any line
that limits agents to server tabs. The guard
`apps/server/src/mcp/toolkits/connForkPreviewCopy.test.ts` fails on the known
phrases. Extend it when upstream finds new words.

Sources:

- Desktop (`apps/desktop/src/preview/`): `DesktopTabRunner.ts`, `CdpRelay.ts`,
  `Manager.ts`.
- `apps/server/src/mcp/PreviewAutomationBroker.ts`.
- `apps/server/src/preview/DesktopTabRelay.ts`.
- Web (`apps/web/src/`): `rpc/desktopTabRelay.ts`, `browser/`.
- `packages/contracts/src/previewAutomation.ts`.
- Shared (`packages/shared/src/`): `previewPage.ts`, `previewSessionControl.ts`.
- `docs/user/default-browser.md`.

### Agent-opened panels

A thread's agent can show a panel in the Conn desktop with the `panel_open` MCP
tool, so it can show the user its work running: `browser`, `database`, `mcp`,
`diff` or `files`. Only Conn threads can do this; the tool needs a thread scope.

Conn never switches threads for an agent. When the user is on the agent's
thread, Conn comes to the front and opens the panel. On another thread, Conn
prepares the panel for that thread without navigating or coming forward, and
panel actions (`database_query`, `mcp_connect`, `mcp_call`) fail with
`NOT_ON_THREAD`, asking the user to open the thread.

- `browser` with `url` opens a new desktop tab, and later `preview_*` calls
  without a `tabId` drive it. `tabId` shows an existing tab instead.
- `database` with `sql` puts the query in the editor.
- `focusWindow: false` opens the panel without bringing Conn forward, even on
  the agent's thread.

Two tools act inside a panel and answer with its result, so the user and the
agent see the same thing:

- `database_query` picks a Database panel connection by name, puts the query in
  the editor and runs it. The panel runs queries read-only, so it runs without
  asking. The agent gets the columns, the row count and the first 20 rows, with
  values cut at 500 characters. An unknown name fails with the names the panel
  has. A Vault connection may ask for Touch ID.
- `mcp_connect` adds or updates an MCP panel server (by name, else by URL or
  command), selects it and connects. Headers or env carry auth and are saved
  with the server, as typed ones are. The agent gets the server's tools. OAuth
  servers are not supported, as in the panel itself.
- `mcp_call` calls a tool on a saved MCP panel server: the panel selects the
  tool, fills its form with the agent's arguments and shows the result. The
  agent gets the content, with text cut at 8,000 characters and images left
  out, and any structured content. It is meant for building MCP servers: the
  user watches each change work. After the agent changes its server, it
  reconnects with `mcp_connect` so the panel lists the new tools.

The panel carries out the request where it already knows the project's
connections and servers (`pendingByThreadKey` in `databaseStore.ts`,
`useMcpAgentRequestStore` in `mcpStore.ts`). The server waits up to 90 s.

The server sends each request to every desktop connected to it
(`panels.requests` stream); the first desktop that shows the panel answers
(`panels.respond`). With no desktop connected, or when none answers in 15 s, the
tool fails with a clear reason. It never falls back to the headless browser.

The browser opens differently per server. On the server the desktop bundles,
desktop-runtime tabs are not relayed, so the tool opens a native server tab
through the broker's `open` operation. On a remote server (Beast, mini,
nick-vm) it opens a desktop-runtime tab and waits up to 20 s for the desktop to
register as its host. Remote servers need this build too.

Known issue: the first remote browser open after adding an environment once
failed with `tab_not_hosted`; after a renderer reload it worked every time.

To add a panel, add its kind to `AgentPanelKind` and an opener to
`PANEL_OPENERS`. Panel-specific arguments go on `AgentPanelRequest`, and
results on `AgentPanelResponse`.

Sources:

- `packages/contracts/src/agentPanels.ts`.
- `apps/server/src/panels/AgentPanelBroker.ts`.
- `apps/server/src/mcp/toolkits/panels/`.
- `apps/web/src/panels/agentPanelRequests.ts`.
- `apps/web/src/database/databaseStore.ts`, `apps/web/src/mcp/mcpStore.ts`.

### Password-manager autofill

Agents use test logins through the browser panel. `request_credentials` lists
item IDs, titles, usernames and URLs. `fill_credential` checks the tab's origin
and routes through `PreviewAutomationBroker` to the active server or desktop
browser runtime, which inserts the value over CDP.

Personal Vault logins are available only to the user. The address-bar key and
inline suggestions use desktop `vaultFill` IPC to read Vault and fill over the
tab's debugger. A fill marks the document and redacts the value from all CDP
relay messages sent to the server. Open script endpoints close before the fill.
While the mark remains, agents cannot use `preview_evaluate`, open endpoints or
take screenshots; `preview_snapshot` omits its image. Snapshot text and evaluate
results are redacted against masked and filled inputs.

Test logins live in T3 Code's secrets folder. Agents save them with
`save_test_login`. They fill without a prompt and support one-time codes.
Settings › Passwords lists them.

Sources:

- Server (`apps/server/src/`): `credentials/*`, `mcp/toolkits/credentials/*`,
  `preview/ServerBrowser.ts` (`credentialFill`, `credentialLock`, redaction).
- `packages/shared/src/credentialFill.ts`.
- `packages/contracts/src/credentials.ts`.
- Web (`apps/web/src/`): `credentials/*`,
  `components/settings/PasswordsSettings.tsx`.
- Desktop (`apps/desktop/src/`): `preview/Manager.ts` (`fillCredential`),
  `preview/DesktopBrowserHost.ts` (relay redaction),
  `ipc/methods/vaultLogins.ts`, `vault/Logins.ts`.

### Conn (app rename)

The desktop app is **Conn**: `Conn.app` or `Conn (Dev).app`, app ID
`com.nckrtl.conn` (dev `com.nckrtl.conn.dev.<checkout>`), link scheme `conn://`
(dev `conn-dev://`) and user-data folder `conn` (dev `conn-dev`). Window titles,
menus, About, permission prompts, onboarding and the sidebar wordmark use the
name. macOS builds use Apple team 9SVJ4SYB9B.

`forkBrand.json` holds the identity. `appBrand.ts` resolves it, with upstream
values as defaults. `T3CODE_APP_NAME`, `T3CODE_DESKTOP_APP_ID`,
`T3CODE_DESKTOP_SCHEME` and `T3CODE_APPLE_TEAM_ID` override single values. The
desktop bundle bakes in `__T3CODE_APP_BRAND__`; tests and other code use
upstream's defaults. To build the stock app, set `forkBrand.json` to `{}`.

First launch copies `t3code(-dev)` user data to `conn(-dev)`, excluding caches
and lock files and leaving the old folder untouched. Before opening any window,
it copies the old origin's localStorage to the new origin. It re-encrypts saved
secrets if the safeStorage key changes.

The app still handles `t3code://` links. The stock server accepts only that
scheme for sign-in return links, so the web client's `serverReturnHref` uses it.
These also keep their T3 names:

- `@t3tools/*` packages, `T3CODE_*` variables, `t3code:*` localStorage keys and
  `~/.t3/...`.
- The staged package name `t3code`, which fixes the keychain item name "t3code
  Safe Storage".
- Server branding in `apps/server`. The dev backend allows
  `T3CODE_DEV_ALLOWED_ORIGINS=conn-dev://app`. Fork features still change server
  code.

The Conn logo replaces the T3 mark on blueprint dev icons and black production
icons. Fork-owned Icon Composer projects are in
`assets/conn/{dev,prod}/app-icon.icon`, copied from upstream with only
`text.svg` swapped. `assets/conn/export-icons.sh` uses `ictool` to render iOS,
universal, favicon and `.ico` assets into `assets/conn/*/conn-*`. It uses
`assets/conn/safe-area.swift` to place the macOS render in the pre-Tahoe safe
area (824px body, soft shadow), because the GUI-only preset cannot be scripted.

The `icons` entries in `forkBrand.json` select these assets, falling back to
upstream paths in `appBrand.ts`. Source-tree icons, the dev runtime bundle's
`icon-dev.icns` and packaged stable builds use them. Nightly icons stay
upstream's. Desktop packaging applies the Conn name on Linux and Windows as
well; platform integration files retain some T3 names.

`apps/web/public` holds Conn dev favicons and the splash logo.
`vp run icons:check` reports those four assets as stale; `vp run icons:export`
would overwrite them. Packaged stable builds also use the Conn splash logo.

With `T3CODE_IOS_BUNDLE_ID` set, the iPhone's development and production
variants use the Conn iOS icon, `.icon` project and splash. Widgets and Live
Activities use `assets/conn/widget/ConnMark.svg`. Preview and Android artwork
stay T3. Upstream's `assets/{dev,prod,nightly}` are untouched.

Sources:

- Desktop (`apps/desktop/src/`): `branding/*`, `app/DesktopAssets.ts`,
  `app/DesktopEnvironment.ts`, `electron/ElectronProtocol.ts`,
  `app/DesktopAppIdentity.ts`, `app/DesktopApp.ts`, `app/DesktopClerk.ts`.
- `assets/conn/*`.
- Mobile: `apps/mobile/app.config.ts`,
  `apps/mobile/plugins/withWidgetLogoAsset.cjs`.
- `apps/desktop/scripts/electron-launcher.mjs`.
- `apps/desktop/vite.config.ts`.
- `scripts/build-desktop-artifact.ts`, `scripts/sign-macos-local.ts`.
- `apps/web/src/lib/serverReturnHref.ts`.

### Mobile home bar and filter

On iPhone, the bottom toolbar holds Settings, a Threads / Pulls / Search group
and New chat. It replaces upstream's tab bar and hides the top brand, search and
settings bar. The connection status appears above the bottom bar only while
reconnecting.

Tabs are 64pt wide. The toolbar pads custom views about 5pt at each side, so the
group pads only its top and bottom. The selected pill uses foreground at 12% and
sits evenly inside the glass.

Search replaces the group with a toolbar search field for the selected tab.
Cancelling or leaving it empty restores the group. On Threads, the workspace,
environment and project filter sits inside the field, like Mail, replacing
upstream's filter pills. Pull requests keeps its own filter row. The field uses
the composer's text size. This needs the `react-native-screens` patch below.

Sources:

- `patches/react-native-screens-conn.patch`.
- `apps/mobile/src/native/V5StackHeader.ios.tsx` (`filterInsideSearch`, search
  field `fontSize`).
- Workspace (`apps/mobile/src/features/layout/workspace/`): `WorkspacePhoneBar.tsx`,
  `useWorkspacePhoneBar.ts`, `WorkspaceNativeTabs.ios.tsx`,
  `WorkspaceRootScreen.tsx` (`connPhoneBar`).
- Mobile (`apps/mobile/src/features/`): `home/HomeHeader.tsx`,
  `home/HomeScreen.tsx`, `pull-requests/PullRequestsScreen.tsx`.

### Mobile thread feed and lists

The connection pill floats over the thread feed, so messages do not shift while
connecting.

Markdown uses the system font with weights and JetBrains Mono for code. Blocks
and headings have 12pt above/between them; list items have 6pt between them.
List markers start at the list's edge, with an 8pt gap to the text for both
numbers and bullets. This needs the enriched-markdown patch below.

On iOS 26 and later, a native `EdgeBlur` replaces upstream's color fade under
the composer and header, and the composer is realigned. `T3EdgeBlurView` lives
in `t3-composer-editor`.

The iOS composer editor follows Dynamic Type through JS: `T3ComposerEditor.ios.tsx`
sends the body size and line height times `fontScale` and re-renders when the text
size changes. `T3ComposerEditorView.swift` therefore keeps
`adjustsFontForContentSizeCategory` off, re-applies typography on a content size
change, uses the JS font family (default "System"), gives chips the system font and
supports `singleLineCentered`.

The "Worked for" fold row has 10.5pt on both sides of its divider (`mb-3`). Its
fixed size is 49 in `ThreadFeed.tsx` and `thread-feed-item-size.ts`. Dividers on
glass and sheets use foreground at 12%: the working pill, composer command
popover and terminal sheet.

Sources:

- Threads (`apps/mobile/src/features/threads/`): `ThreadDetailScreen.tsx`,
  `ThreadFeed.tsx`, `thread-feed-item-size.ts`, `floating-working-control.tsx`,
  `ComposerCommandPopover.tsx`, `ThreadComposer.tsx`.
- Mobile (`apps/mobile/src/`): `native/EnrichedMarkdownText.tsx`,
  `lib/fonts.ts`, `features/terminal/TerminalContextSheet.tsx`,
  `native/EdgeBlur*`.
- `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorModule.swift`,
  `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift` and
  `apps/mobile/src/native/T3ComposerEditor.ios.tsx`.

### Linked environments (peer links)

The fork retains linked environments, delegation to them and environment link
MCP tools from upstream's `t3code/peer/*` stack, imported through the v0.0.46
preview tag. The stack is not yet on the synced upstream `main`.

Its migration is `070_PeerLinks`; upstream uses 61 through 69.
`reconcileConnPeerLinksMigration` moves records from 61 through 69 to 70 and
runs the upstream migrations they displaced. A runtime from before the move (69)
cannot start on a database that a 70 runtime has migrated, so a rollback past it also
needs the database backup taken before the update. See the merge rules below for the required
startup order and future ID conflicts.

Plain HTTP links also work for Orbit WireGuard addresses in `10.44.0.0/16`
(`isOrbitWireGuardHost` in `apps/server/src/peer/PeerLinks.ts`). WireGuard
encrypts this traffic. Upstream allows only HTTPS, loopback and Tailscale. When
the stack lands on upstream `main`, drop Conn's copy and reconcile the migration
ID again.

`t3 environment link-orbit <id>` links a server that Orbit lists without a pairing code in
an agent's transcript. The server asks the Gateway for a pairing as its own Node, follows the
Operation (one pairing per call), takes the code from the link and calls `PeerLinks.link` with
the Gateway's URL for that server. It prints only the outcome, or `<code>: <message>`.

Stale records never take a link: a switched-off saved server offers no addresses
(`linkableMachines` in `packages/client-runtime/src/linkRequest.ts`), so a card for an address
that Orbit gave to a new Instance links whatever answers there now. When a saved server still
claims the address, `PeerLinks.answeringAs` names both: `<url> now answers as <label> (<id>),
not <expected>.` There is
no MCP tool for it: agents that orchestrate Orbit clones run `t3` in a shell, and a tool would
add to every agent's tool list. A peer with Linked environments off refuses with
`peer_disabled` (`PEER_LINKS_OFF_DESCRIPTION`), shown as `target_links_off`. The server reuses
the Gateway client from `packages/client-runtime/src/orbitGateway/client.ts`.

Sources:

- Server (`apps/server/src/`): `peer/*`, `persistence/Migrations.ts`,
  `mcp/toolkits/orchestrator/*`, `orbit/OrbitEnvironmentLink.ts`, `cli/environment.ts`.
- `packages/contracts/src/rpc.ts` (`peerLinks*`).

### Orbit registration

`scripts/orbit/t3-orbit-register URL` registers the host's T3 server with the
Orbit Gateway. It issues a fresh admin session labeled "Orbit Gateway" and
sends it to `POST /api/v1/conn/environments`. A scheduled job runs it daily,
because the Gateway's admin session expires.

The script needs the T3 CLI of the server that is running now. On macOS, give
it the server's launchd job with `--service-label LABEL`. At every run it reads
the first argument of the loaded job (`launchctl print gui/<uid>/LABEL`). Only
when launchd does not know the job does it read `ProgramArguments` of
`~/Library/LaunchAgents/LABEL.plist` with `plutil`. It skips an
`env VAR=value` wrapper. The label differs per host:

- mini: `com.t3tools.t3code.service`.
- nick-vm: `com.nckrtl.conn-server`.
- nick headless: `com.nckrtl.t3-headless`.

Install the script in `~/.local/bin`. Fill in the placeholders of
`scripts/orbit/com.nckrtl.t3-orbit-register.plist` and put it in
`~/Library/LaunchAgents`. It logs to `~/Library/Logs/t3-orbit-register.log`.
`RunAtLoad` registers as soon as the job loads, so load it only when you mean
to register. On Linux, install `scripts/orbit/t3-orbit-register.service` and
`.timer` in `~/.config/systemd/user`. Put `T3_ORBIT_REGISTER_URL=<url>` in
`~/.config/t3-orbit-register.env`, then enable the timer and lingering. The
unit runs the `~/.local/bin/t3` launcher symlink, which updates repoint.

> [!WARNING]
> Never put a versioned runtime path (`…/runtime/versions/<version>/t3`) in a
> register or relink job. Runtimes are pruned after updates, and `t3 update`
> repoints only launcher symlinks, not job files. On 2026-10-30 nick-vm's job
> still pointed at the pruned 0.0.46 runtime and failed with "No such file or
> directory". It had not registered since 2026-10-27. The script warns when
> it gets a versioned path. `--print-cli` shows the binary it resolves
> without contacting anything. `sh scripts/orbit/t3-orbit-register.test.sh`
> checks the lookup offline.

> [!WARNING]
> On 2026-11-06 a hand-run `plutil -extract ProgramArguments json FILE`
> (without `-o -`) rewrote the server plists on mini and nick-vm as bare JSON
> arrays. PlistBuddy could not read them, so registration failed until
> 2026-11-13. The lookup now asks launchd first.

Sources:

- `scripts/orbit/t3-orbit-register`,
  `scripts/orbit/com.nckrtl.t3-orbit-register.plist`,
  `scripts/orbit/t3-orbit-register.service`,
  `scripts/orbit/t3-orbit-register.timer`,
  `scripts/orbit/t3-orbit-register.test.sh`.

### Linked environment renewal

Linked sessions expire after 30 days without automatic renewal in T3.
`scripts/orbit/t3-orbit-relink` renews links that expire within 10 days. It
requests a pairing link with `POST /api/v1/conn/environments/<id>/pairings`,
then links again with the same addresses and access.

Install the script in `~/.local/bin`, next to `t3-orbit-register` (see Orbit
registration), and its
`scripts/orbit/com.nckrtl.t3-orbit-relink.plist` in `~/Library/LaunchAgents`. It
runs daily and logs to `~/Library/Logs/t3-orbit-relink.log`. Its
`--service-label LABEL` finds the T3 CLI with the same lookup as
`t3-orbit-register` (set the label of the host's server job). A failed
`environment list` fails the run. The recorded mini
setup links nick, beast and shark with full access.

It also renews links whose status is already `expired`. On Linux hosts install
`scripts/orbit/t3-orbit-relink.service` and `.timer` in `~/.config/systemd/user`,
enable the timer, and enable lingering (`loginctl enable-linger`) so it runs
without a login session.

Gateway codes carry administrative scopes. Renewed sessions therefore have more
scopes than the app's orchestration-only request.

Sources:

- `scripts/orbit/t3-orbit-relink`,
  `scripts/orbit/com.nckrtl.t3-orbit-relink.plist`,
  `scripts/orbit/t3-orbit-relink.service`, `scripts/orbit/t3-orbit-relink.timer`.

### Machine @-mentions

Typing `@` in the composer offers other T3 Code environments alongside threads
and files. Picking one inserts a machine chip. Messages carry only the
environment ID and label. The agent is told to use `t3_environment_link` before
delegating there.

Web persists `environmentContexts` on the composer draft and restores them on
undo or failed sends. Upstream's thread contexts use the attachment draft.
Mobile offers machines in the `@` popover and draws chips natively through
`t3-composer-editor` (`T3ContextChip` on Android).

Sources:

- Web (`apps/web/src/components/`): `chat/ChatComposer.tsx`
  (`composerEnvironmentContexts`), `ChatView.tsx`, `ChatView.logic.ts`,
  `EnvironmentContextChip.tsx`, `composerContextPresentation.tsx`,
  `contextPresentationRegistry.ts`, `chat/ComposerCommandMenu.tsx`,
  `chat/MessagesTimeline.tsx`.
- Mobile (`apps/mobile/src/`): `features/threads/use-composer-command-menu.ts`,
  `features/threads/ComposerCommandPopover.tsx`, `lib/composerContext.ts`,
  `state/environments.ts`.
- Native chips: `apps/mobile/modules/t3-composer-editor/`.

### Mobile Operator dictation

Settings > Voice lets the user select an Operator server and sign in, instead
of using the device recognizer. Keep both the settings UI
(`SettingsTranscriptionSection.tsx`) and the recording consumer connected to
`voice-input/operatorTranscription.ts`. A recording with Operator selected
must use `getOperatorVoiceTranscriber`; its availability must also reach the
microphone control. Preserve this choice alongside upstream's environment and
cloud transcription routes. The November 7 sync kept the settings but removed
the consumer from `VoiceInputProvider.tsx`.

Sources under `apps/mobile/src/features/`:

- `settings/SettingsVoiceRouteScreen.tsx`, `settings/SettingsTranscriptionSection.tsx`.
- `voice-input/VoiceInputProvider.tsx`, `voice-input/voiceDestination.ts`,
  `voice-input/operatorTranscription.ts` and its tests.

### Fork RPC group

Conn's fork contracts live in `ForkWsRpcGroup`. On November 8, Nick authorized
restoring the RPCs required by annotation queues and Orbit registration. The
Orbit registration RPCs (`orbitWorkspaces.*`) left with the worktree-based Orbit
mode, so the group is `annotations.{subscribe,create,remove}`. `wsFork.ts` mounts
only these three methods; `ws.ts` merges them into the production socket group. Keep their
handler layer separate from the large upstream groups to avoid TypeScript's
handler-type expansion limit.

Subscriptions require `orchestration:read`. Annotation mutations require
`preview:operate`. Both the
scope authorization and instrumentation middleware apply to the fork group.
`wsFork.test.ts` exercises the handlers through RPC, including rejected
mutations and the real annotation store. `wsMountedRpc.test.ts` checks the
production mount against the explicit three-method allowlist.

`serverRestart`, `credentials*`, `testLogins*` and `panels.*` remain unmounted.
Do not broaden this allowlist during an upstream sync without a new decision.
Typed contracts alone do not prove a method is available on a server.

Sources:

- `packages/contracts/src/rpc.ts` (`OfficialWsRpcGroup`, `ForkWsRpcGroup`).
- `apps/server/src/wsFork.ts`, `ws.ts`.

### Codex MCP network wait

Codex starts a thread's MCP servers once and never retries one that failed.
After a reboot the Orbit network (WireGuard, `*.orbit`) can come up after the
T3 server spawns `codex app-server`, and those threads run without Recall or
executor tools. Before it spawns `codex app-server`, the Codex adapter waits
until every enabled `*.orbit` URL under `[mcp_servers.*]` in the effective
`config.toml` accepts a TCP connection. The wait has a 120-second budget, set
with `T3CODE_CODEX_MCP_WAIT_SECONDS` (`0` turns it off), then the spawn goes
ahead with a warning. The result is cached per config file, so only the first
spawn per server process can wait. Configs without `*.orbit` MCP URLs never
wait.

Sources:

- `apps/server/src/provider/codexMcpNetworkGate.ts`.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`
  (`layerAppServerClientFactory`).

### Swipe navigation setting

Upstream's two-finger trackpad swipe goes back and forward in history. It can
fire while the user scrolls and switch to the previous thread. Settings >
General > "Swipe between threads" (`historySwipeNavigation`, default on) turns
it off. On a conflict, keep the setting gate around `<HistorySwipeNavigation />`.

Sources:

- `packages/contracts/src/settings.ts` (`historySwipeNavigation`).
- `apps/web/src/components/AppSidebarLayout.tsx`.
- `apps/web/src/components/settings/SettingsPanels.tsx`,
  `apps/web/src/components/settings/settingsSearch.ts`.

## Keep the customizations through an upstream merge

1. Merge `upstream/main` into the sync branch. Work through every conflict,
   keeping all fork work and as much upstream work as possible. Conflicts are
   expected in the files listed above, most often `index.css`,
   `components/ui/*`, `ChatView.tsx`, `RightPanelTabs.tsx`, settings components
   and the sidebar. Keep the fork's side for styling and fork features, and
   re-apply upstream's logic and new features around it. Never drop a fork
   feature or an upstream fix to make a merge clean. Use the
   [nckrtl-shell-design skill][shell] as the rules for every UI conflict. Commit
   the resolution with a message that lists each conflicted file, how it was
   resolved, and which resolutions are uncertain. Known spots and how to resolve
   them:
   - `apps/server/src/persistence/Migrations.ts`: keep Conn's
     `reconcileConnPeerLinksMigration` call in `runMigrations`, before
     upstream's `assertV2MigrationsCanRun`, behind the same `hasPending` gate
     as upstream's V2-preview reconcile (the CLI must not take the write lock
     on a current schema), and keep `070_PeerLinks` after upstream's IDs (move
     it past any new upstream ID and extend the reconcile).
   - `apps/web/src/components/chat/ChatComposer.tsx`: take upstream's draft
     changes, but keep `composerEnvironmentContexts` from `composerDraft`.
   - Composer: upstream's composer redesign (#25869) is adopted as of
     2026-10-30 (Nick); Conn's own composer animation is retired. On conflicts
     in composer files take upstream's composer and re-apply only the listed
     fork features (environment contexts: `composerEnvironmentContexts`, the
     `@` environment chips, `EnvironmentContextChip.tsx`).
   - Composer fill: `ComposerSurface.tsx` sets
     `--chat-composer-glass-surface` to `--shell-composer` (`index.css`), so
     the dark composer sits a step lighter than the chat card (Nick,
     2026-11-11). Upstream's `--surface-raised` equals the card there.
   - Terminal actions: with one terminal group, `ThreadTerminalDrawer.tsx`
     floats the actions in a `ToolbarGroup` at the top right, level with the
     first terminal line. Upstream #23373 gives them their own row; the
     November 3 sync took that row. Keep the floating group and take
     upstream's row only in the split sidebar header.
   - Shell glass and sidebar card: in
     `apps/desktop/src/window/DesktopWindow.ts` keep the macOS `vibrancy`,
     `visualEffectState` and clear background, both at window creation and in
     `syncWindowAppearance`. In `apps/web/src/components/Sidebar.tsx` keep the
     `shell-inner-panel` wrapper around `SidebarContent` and
     `<SidebarChromeFooter utilities={false} />` inside it. Keep the back and
     forward buttons out of `SidebarChromeHeader`. Take upstream's
     sidebar content changes inside that wrapper. The November 7 sync dropped
     all three; see [Shell design](#shell-design).
   - `apps/web/src/components/ChatView.tsx`: keep `<ConnIconScope>` around
     `<MessagesTimeline>`;
     `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`: keep
     `<ConnSymbolScope>` around `<ThreadFeed>`.
   - `apps/mobile/src/components/ui/AppSymbol.tsx` (was `AppSymbol.ios.tsx` until 2026-11-10): keep Conn's version (no
     Tabler; `conn.` names inside `ConnSymbolScope`).
   - Work-log icon unions (`thread-work-log.tsx`): keep both sides' icons.
   - `apps/web/vite.config.ts` (`resolve.alias`), `apps/web/tsconfig.json`
     (`paths`), `apps/web/package.json` (`lucide-react-original`,
     `lucide-original`, `@phosphor-icons/react`), `apps/mobile/package.json`
     (the `-conn.tgz` tarballs) and `pnpm-workspace.yaml` (the Conn tarball's
     build allowance): keep the Conn entries next to upstream's.
   - Desktop relay routing: keep
     `apps/server/src/mcp/PreviewAutomationBroker.ts`,
     `apps/server/src/preview/DesktopTabRelay.ts` and the desktop runner in
     `apps/desktop/src/preview/DesktopTabRunner.ts` connected through the client
     stream. Preserve thread scoping, one host per tab and Playwright over
     `CdpRelay.ts` on `webContents.debugger`. Keep the relay blocks on commands
     that close the guest or disable shared debugger events. Preserve the
     `preview_cdp_endpoint` tool and its wiring in
     `apps/server/src/mcp/toolkits/preview/tools.ts` and
     `apps/server/src/mcp/McpHttpServer.ts`.
   - Desktop bridge: preserve `apps/desktop/src/preview/Manager.ts`,
     `apps/desktop/src/ipc/methods/preview.ts` and
     `apps/desktop/src/preload.ts`. Retain `capturePage` with `stayHidden` and
     the Vault privacy controls described above.
   - Web relay: preserve stable tab identity, automatic hosting and
     `acquireBrowserSurfaceActivity` while the thread is off screen. Keep
     re-registration after a server restart. Interrupted requests must fail
     without replay. The files under `apps/web/src/` are
     `rpc/desktopTabRelay.ts`, `browser/HostedBrowserWebview.tsx`,
     `browser/ElectronBrowserHost.tsx` and `browser/previewRuntimeTabId.ts`.
   - Laravel Toolbar: preserve the `BrowserLaravelToolbar` mount in
     `components/preview/PreviewView.tsx`, not just the files in
     `laravelToolbar/`. Keep its guest-message consumer in
     `browser/HostedBrowserWebview.tsx` and the preload/header path described
     above. Run `PreviewView.browser.test.tsx` after changing preview layout.
   - Workspace and annotation UI: preserve the list consumers and visible
     controls described above. A rail, store, overlay or optional prop that
     still exists but has no caller is a lost feature.
   - Mobile voice: preserve the Operator selection from settings through the
     actual recorder/transcriber route when adopting upstream voice changes.
   - Under `packages/contracts/src/`, keep Conn's desktop preview entries in
     `previewAutomation.ts`, `rpc.ts`, `ipc.ts` and `clientRpcPermissions.ts`
     next to upstream's.
   - `apps/server/src/preview/ServerBrowser.ts` shares page operations and
     session control with the desktop runner. Port relevant upstream changes
     into `packages/shared/src/previewPage.ts` and
     `packages/shared/src/previewSessionControl.ts`. Do not restore separate
     server copies.
   - In `apps/server/src/preview/Manager.ts`, keep `"desktop"` as the default
     runtime for an implicit tab. Keep `docs/user/default-browser.md` aligned
     with the behavior.
   - If upstream adds desktop-tab automation, compare both implementations
     against the behavior above. Keep Conn's behavior unless Nick decides
     otherwise.
   - Annotations: keep `layerAnnotationsToolkit` in
     `apps/server/src/mcp/McpHttpServer.ts`, the `ConnAnnotationsPreload.ts`
     import in `apps/desktop/src/preview-pick-preload.ts`, the overlay
     injection and binding in `apps/server/src/preview/ServerBrowser.ts`, the
     `annotations.*` contracts (subject to the known server restriction in
     [Fork RPC group](#fork-rpc-group)), and
     the `attachOverlayBridge` effect in
     `apps/web/src/browser/HostedBrowserWebview.tsx`.
   - `pnpm-lock.yaml`: take upstream's, then let `vp i` rewrite it.
   - `playwright-core` in `apps/server`, `apps/desktop` and `packages/shared`
     must stay on one version: `@t3tools/shared/previewPage` takes the pages
     both runners create, so a split fails the server typecheck. Conn pins
     1.60.0 (1.64.1 breaks `DesktopTabRunner` resize fill); move all three
     together. `scripts` and `apps/web` (`playwright`) stay on upstream's
     version; they do not share pages with the runners.
   - Fork Swift and Kotlin files (`apps/mobile/modules/*/ios`, `*/android`):
     CI lints native code but never compiles it, so a merge that takes
     upstream's copy passes CI and breaks the app. The November 7 sync took
     upstream's `T3ComposerEditorView.swift` and dropped `setSingleLineCentered`
     (the build failed) and the Dynamic Type changes (no error at all). Diff every
     fork native file against the sync's first parent, and keep the fork's side
     unless upstream changed the same lines.
2. Run the regression scan in the shell skill's "Upstream sync procedure" on
   upstream's diff. New upstream UI must follow the fork's shell rules (glass
   popovers, `ToolbarGroup`, `text-ui`, shell dividers, `scrollbar-inset`). Fix
   what the scan finds on the sync branch, before the build.
   Compare the sync with its first parent for removed fork imports, renders,
   props, subscriptions and service registrations. Trace each removed consumer
   to its replacement and exercise its user-visible behavior. A surviving
   implementation file or a green typecheck is not evidence of preservation.
3. Lint and typecheck only the touched scope (`vp lint <files>` and
   `vp run check:changed`). `check:changed` always typechecks
   `@t3tools/desktop`, and `scripts/build-desktop-artifact.ts` runs
   `vp run --no-cache --filter @t3tools/desktop typecheck` (the existing Vite
   task) before packing. Either path fails closed on a missing window or preview
   member. Do not add `scripts.typecheck` to `apps/desktop/package.json`;
   that name conflicts with the Vite task. Run the tests for the fork areas
   you touched (from the root, use `vp test run` with paths such as
   `apps/web/src/laravelToolbar`, `apps/web/src/annotations`,
   `apps/web/src/workspaces.test.ts` and `apps/desktop/src/window`). For desktop
   tab automation, run `apps/desktop/src/preview/DesktopTabRunner.test.ts`,
   `apps/desktop/src/preview/CdpRelay.test.ts`,
   `apps/server/src/mcp/PreviewAutomationBroker.test.ts`,
   `apps/server/src/preview/DesktopTabRelay.test.ts`,
   `apps/web/src/rpc/desktopTabRelay.test.ts` and
   `apps/web/src/browser/ElectronBrowserHost.test.tsx`. These focused relay
   tests need a Playwright headless shell. Always run the fork guards
   `apps/mobile/src/native/connForkPatches.test.ts`,
   `apps/web/src/icons/connIcons.test.ts`,
   `apps/server/src/mcp/toolkits/connForkPreviewCopy.test.ts`,
   `apps/web/src/components/sidebar/connShellSidebar.test.ts` and
   `apps/desktop/src/window/DesktopWindow.test.ts`. Run `vp i` first: merges change
   dependencies. When the web typecheck reports a Lucide name missing from
   `apps/web/src/icons/lucide-react.ts`, add a line for it (the Lucide icon and
   the closest Phosphor icon). New SF Symbol names in the mobile thread feed
   stay SF Symbols until they get an entry in
   `apps/mobile/modules/conn-symbols/symbols.json` and
   `node scripts/build-conn-symbols.ts` runs. If upstream bumps a vendored
   tarball in `apps/mobile/deps`, rebuild Conn's as described below.
4. Publish the exact build commit to an origin `sync/` branch
   (`node scripts/publish-sync-branch.ts`; a dated `sync/<yyyy-mm-dd>` tip
   already counts). Then build, sign and install with the [build guide][build].
   Merge the sync branch into `main` only after a good build.

### Upstream sync audit: 2026-11-08

Source audit of the six November 1–8 sync merges against their first parents,
then checked against `ff4fb8d847a9e8ca5f262e6c38cd5a039aa164ee` and the repair
commits between them. This is a call-site and history audit of fork features,
not runtime acceptance of every desktop and mobile feature.

| Sync date  | Merge        |
| ---------- | ------------ |
| November 1 | `09e37a43cc` |
| November 2 | `7444c815b2` |
| November 3 | `337aad549b` |
| November 4 | `b129d4f5cb` |
| November 7 | `4b7c3e1509` |
| November 8 | `2ef40fa2f6` |

The following lost consumers all trace to `4b7c3e1509` and are restored in
this repair. Preserve these connections when adapting future upstream changes:

| Feature                                 | Loss and evidence                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser Laravel Toolbar                 | `PreviewView.tsx` lost its import and render of `BrowserLaravelToolbar`. Restored here; the regression test fails without the mount. `Manager.prepareWebview` also lost the guest header and dictation attachments; these are restored.                |
| Desktop workspace filtering and editing | `Sidebar.tsx` no longer calls `publishProjects` or `resolveScopedProjectKeys` with the active workspace. The sidebar ignores workspace selection; `WorkspaceDialog` reads an unpopulated project registry.                                             |
| Mobile workspace filtering              | `HomeScreen.tsx` and `ThreadNavigationSidebar.tsx` no longer call `selectedWorkspaceProjectRefs`. The phone filter could select a workspace, but the thread list did not use it. Sidebar and Android filter consumers also lost the workspace choices. |
| Browser and device annotation queues    | `PreviewView.tsx` lost `BrowserAnnotationControl`; `DeviceWorkspace.tsx` lost its queue hook, annotation props and `AnnotationQueuePopover`. The upstream picker remains, but Conn's queue controls are disconnected.                                  |
| Operator mobile dictation               | `VoiceInputProvider.tsx` stopped selecting `getOperatorVoiceTranscriber`. Settings and authentication remain, but neither the provider nor its replacement `voiceDestination.ts` reads that selection.                                                 |

The same sync removed the fork server RPC handlers. `3ab777b7c8` briefly
restored a separate group, then `6bf5145e37` removed it again and `e5053317cb`
added tests enforcing the exclusion. Nick's November 8 decision restores the
annotation and Orbit RPCs needed by these features; the Orbit ones later left with the
worktree-based Orbit mode. The other fork RPCs remain excluded; see [Fork RPC group](#fork-rpc-group).

Validation in `nick-vm`: the stock Laravel container spike renders its toolbar
in a fresh native desktop tab; request details open, and navigation to a
non-Laravel page clears the toolbar. The workspace editor lists projects again.
A page-bridge annotation appears in the live queue and is removed through the
queue RPC in the rebuilt desktop app.
A tab already marked headless remains server-rendered and does not receive the
native preload's toolbar data; this repair does not add a headless toolbar
transport. Reopen it as a fresh desktop tab to use the native path.

The focused RPC tests verify annotation create/list/remove and Orbit
register/list/remove, plus rejection of unauthorized mutations. Mobile route
and filter tests pass; physical-device dictation and native mobile UI were
not exercised in this VM run.
`check:changed` passes formatting, lint, Knip, GraphQL, 297 focused tests and
17 compiler checks. Typechecking reproduces the same existing server errors
on unchanged `ff4fb8d847a9`; no new server diagnostics remain.

The Operator route now lives in `voiceDestination.ts`, alongside upstream's
environment and cloud routes. Selecting Operator clears an explicit remote
route; selecting device transcription clears Operator. An explicitly selected
remote route never silently falls back to Operator.

Several other losses were repaired before the audited head: workspace windows
and titles (`c61fc3639b`, `c8d4aedbf4`), desktop tab hosting and Vault fill
(`2a4d7df207`, `f5889fa273`), the iPhone home bar/header (`6e8954e090`), Orbit
connection settings (`78acc025df`, `c8b7e2ed32`), and shared exports
(`111129c3bd`). The consumers listed above needed this additional repair.
No additional unresolved fork-feature loss was confirmed in the other five
syncs by this audit.

This audit missed three more losses from `4b7c3e1509`, found through Nick's
annotations on 2026-11-10 and restored with guard tests: the macOS window glass
(vibrancy in `DesktopWindow.ts`), the sidebar's `shell-inner-panel` card, and
`utilities={false}` on its footer (the duplicate utility row). The 2026-11-04
fix for the missing space above panel toolbar controls (annotation #264) never
reached `main` and is restored too. A visual change needs its rule in this file
and a guard, or a later sync can drop it while every check passes.

### Upstream sync audit: 2026-11-11

The sync merge `954d199524` (upstream `b883156e26`) kept `apps/server` on
upstream's `playwright-core` 1.64.1, while `b6d0582df6` kept desktop and shared
on 1.60.0. The server typecheck failed on `ServerBrowser.ts` and
`ServerBrowserPage.test.ts`; the server is back on 1.60.0. The fork work of
November 10–11 (#11–#27) survived: every line those PRs added is still there
(one test call follows upstream's new `assistantCitationNavigation` signature),
`ci.yml` and this file are unchanged by the merge, and their tests and the fork
guards pass.

### Upstream sync: 2026-11-12

Merge of upstream `4ae66e2e86` (427 commits). Decisions worth keeping in mind:

- Upstream removed icon morphing and `MorphIcon` (#33985) and the vanilla
  `lucide` dependency. The sync took the removal: toggles swap icons through
  `lucide-react` (Phosphor inside `ConnIconScope`). The `lucide` alias and
  `icons/lucide.ts` stay for the `connIcons` guard.
- Upstream dropped the `@betteroffice/fonts-cjk` alias and its stub module for
  the real package; the alias is gone from `vite.config.ts` here too.
- `apps/desktop/scripts/dev-electron.mjs` keeps the fork's dev-runner/orphan
  lifecycle (`dev-electron-lifecycle.mjs`, `T3CODE_DEV_RUNNER_PID`); upstream's
  simpler parent-pid watch was not taken.
- `Migrations.ts` keeps the Conn reconcile for a PeerLinks record at 61-69.
  Upstream now ships `70_PeerLinks` itself, and `hasPendingMigrations` also
  treats a legacy PeerLinks row below 70 as pending so the fast path never
  skips the reconcile.
- The snapshot size bounder keeps the fork's balancing of page text against the
  ARIA tree, now above upstream's 2,000 character floor.
- `agentContextBudget.json` `mcpToolListJsonBytes` is 57,796 with the fork's
  toolkits.

### Upstream sync: 2026-11-16

Merge of upstream `6b7027b1f4` (302 commits). Decisions worth keeping in mind:

- Upstream #32764 makes `McpToolAccess.toLayer` die unless every thread-bound
  declaration's tool carries `McpSchema.EnabledWhen` =
  `McpInvocationContext.hiddenFromOutsideClients`. Conn's annotations,
  credentials (Vault) and panels toolkits now carry it on every tool; a new
  fork tool that acts as the calling thread needs it too, or the server's MCP
  layer fails to build. Outside clients get "Tool not found" for them.
- Upstream moved the mobile thread sync status from the composer pill to the
  header (#37076); the sync took that, so `ThreadDetailScreen.tsx` no longer
  takes `threadSyncStatus`. The fork's `connectionCheckOnly` and
  `<ConnSymbolScope>` stay.
- `react-native-screens` is on upstream's `5.0.0-t3.57` with Conn's rebuilt
  `-conn.tgz`; the Conn patch applied without changes.
- `useCloseAppModal({ replace })` keeps the fork's option; upstream's fallback
  now always replaces the history entry.
- `agentContextBudget.json` `mcpToolListJsonBytes` is 59,401 with the fork's
  toolkits.

### Upstream sync: 2026-11-17

Merge of upstream `9e32c95576` (139 commits). Decisions worth keeping in mind:

- `Migrations.ts`: upstream gates the V2-preview reconcile on `hasPending`
  (#37564); Conn's PeerLinks reconcile takes the same gate. No migration id
  changed: the registry equals upstream's (1-96).
- Upstream #31396 moved `resolveDesktopSshCliRunner` into
  `apps/desktop/src/ssh/DesktopSshEnvironment.ts`; Conn's
  `upstreamReleaseVersion(appVersion)` archive version moved with it.
- Mobile composer: upstream's animated compact/multiline editor (#37562) with
  Conn's Dynamic Type text and measured `expandedToolbarReserve`.
- Mobile thread status: upstream's rework (#37508, #37767, #37797); Conn keeps
  `connectionCheckOnly` so a connecting pill floats over the feed.
- Upstream #37500 removed `isSidebarHiddenThread`; `OrbitInstancesPage`
  filters with `isListedThreadLineage`.
- `react-native-screens` is on upstream's `5.0.0-t3.58` with a rebuilt
  `-conn.tgz`; the Conn patch applied without changes.
- Conn Server followed (see `apps/conn-server/docs/status.md`).
- Out of scope, taken as upstream without build or test: GitLab
  (`packages/source-control-gitlab`), Azure DevOps
  (`packages/source-control-azure-devops`), Android (`AppSymbol.android.tsx`),
  Windows PATH probe (#37632), Forgejo/Gitea links (#37703).

### Vendored dependency patches

Upstream vendors some dependencies as tarballs in `apps/mobile/deps`, which pnpm
patches cannot target. Conn keeps its changes to them as patch files and ships a
rebuilt tarball next to upstream's:

- `react-native-screens`: `patches/react-native-screens-conn.patch` adds a
  search field accessory (a toolbar menu item shown inside the toolbar search
  field) and a `fontSize` prop for the search bar.
- `react-native-enriched-markdown`:
  `patches/react-native-enriched-markdown-conn.patch` sizes each list's marker
  column to its widest number (iOS), so numbers start at the list's edge like
  bullets, and ends bullets where numbers end, so both keep the same gap to the
  item text. `pnpm-workspace.yaml` allows the Conn tarball's install script next
  to upstream's.

`node scripts/build-conn-vendored-tarball.ts <package>` applies a patch to
upstream's tarball and writes `<upstream tarball name>-conn.tgz`;
`apps/mobile/package.json` points at that file.

After a merge that bumps upstream's tarball, keep upstream's new tarball, delete
the old `-conn.tgz`, run
`node scripts/build-conn-vendored-tarball.ts <package>`, point
`apps/mobile/package.json` at the new `-conn.tgz` and run `vp install`. If a
hunk no longer applies, port the change to the new upstream sources, regenerate
the patch with `diff -ruN a b` from the two extracted `package` directories, and
rebuild. The guard test fails while any of this is missing.

For rollback, the sync merge's first parent (`<merge>^1`) is the previous tip,
and the install keeps a backup of the previous app. `main` takes the sync only
after a good build. If an automatic merge damaged fork work, revert the merge
(`git revert -m 1 <merge>`) and redo the sync by hand.

When a fork feature, file path or rule changes, update this file in the same
commit.

[build]: .agents/skills/nckrtl-shell-design/references/build.md
[shell]: .agents/skills/nckrtl-shell-design/SKILL.md

## Pull request runners

Fork CI runs on GitHub-hosted Ubuntu and macOS. Upstream uses Blacksmith. The fork targets a five-minute full CI run from the first job start through Check. It fits the largest CI fan-out in GitHub's 20-job limit with eight server shards, five web shards, four package shards, Build and Typecheck, Rust and Release Smoke, and Mobile Native Static Analysis. Other workflows and runner queues can affect wall time.

Build and Typecheck also runs the fork's Lint checks. Check requires it to succeed even for docs-only changes. One fork runner runs Rust and Release Smoke, each with its own change gate. Upstream still runs separate jobs. Full inputs such as CI setup, dependency patches, vendored mobile dependencies and manifests exercise all Linux checks. Pushes to main always run the Linux checks and also run native mobile analysis for affected files.

On a sync keep the fork-only workflow conditions and matrices in `.github/workflows/ci.yml`, including Check's skip rules and the package-shard filters. Keep the fork's `apps/server/src/testUtils/shardWeights.json` and refresh it from the per-file durations in Test Server logs when shards drift.

The fork's server imports a few client-runtime modules (`apps/server/src/orbit/OrbitEnvironmentLink.ts` uses the Orbit Gateway client), which upstream's server does not. `FORK_FILE_DEPS` in `.github/scripts/ci-changes.cjs` makes the server depend on those files, not on the whole package, so a client-runtime change elsewhere skips the server shards. `scripts/ci-changes-fork.test.ts` walks the server's imports into client-runtime (failing on any it cannot resolve) and fails when one leaves that list, or when client-runtime gains a workspace dependency the server lacks. On a sync keep `FORK_FILE_DEPS`, its `EXTRA_OWNERS` line and its `readWorkspace` filter.

The fork also skips upstream's `setup-apt-mirrors` action and installs the browser secret helper's libraries with `.github/scripts/fork-apt-install.sh`. On 2026-11-11 Canonical's nameservers stopped answering, the runners could not resolve `*.ubuntu.com`, and every Build and Test job hit its limit in apt. The script skips apt when the packages are installed (`libsecret-1-dev` is not on GitHub's image). Otherwise it tries azure.archive.ubuntu.com, mirrors.edge.kernel.org and archive.ubuntu.com in turn. It skips a host that does not resolve and gives each mirror 60 s, with private signed noble main and universe indexes, 5 s network timeouts and no retries. The Finish step waits at most 240 s and always prints the log. On a sync keep the `github.repository` conditions on the `setup-apt-mirrors` step and in both Start steps, and the bounded wait in both Finish steps (it applies upstream too).

Test Web runs its tests through `.github/scripts/web-test.cjs`. Headless Chromium on the GitHub-hosted runners sometimes drops its vitest connection (`VITEST_BROWSER_CONNECTION_CLOSED`) with no failed test, several times a day, during a different file each time. A check that fails on infrastructure is not a gate, but a test that crashes the page every time must stay red. So when the only problem is that error (no failed test, failed file, assertion or other unhandled error), the wrapper reruns only the files that did not finish, including the one that closed, and passes with a warning annotation if they pass. It fails if the browser closes again, if Vitest printed no summary, or if no file had passed. `web-test-reporter.mjs` records the shard's files (sharded with Vitest's own sequencer) and each finished file, so the list survives the crash. The Changes job runs the wrapper's tests (`web-test.test.cjs`). On a sync keep the wrapper in the Test step, and the two sparse-checkout lines and test step in Changes.

Upstream-only workflows need upstream's Blacksmith runners and secrets (relay, web, EAS and macOS previews, showcase screenshots, Windows tests), and the fork has neither. Their entry jobs check `github.repository == 'pingdotgg/t3code'`, so they skip in the fork instead of queueing forever; jobs that depend on them skip too. This covers `relay-preview.yml`, `relay-preview-cleanup.yml` (its daily schedule queued forever before), `web-preview.yml`, `mobile-eas-preview.yml`, `mobile-eas-preview-fork.yml`, `desktop-macos-preview.yml`, `desktop-macos-preview-publish.yml` (the `resolve` job), `mobile-showcase-screenshots.yml`, `windows-tests.yml`, `mobile-android-apk.yml`, `publish-aur.yml`, `deploy-relay.yml` and `release.yml` (the `resolve_commit` job). `release-desktop.yml` has no check of its own: only `release.yml` and `desktop-macos-preview-publish.yml` call it, and both skip here. On a sync keep these conditions, and check new upstream workflows for Blacksmith labels.

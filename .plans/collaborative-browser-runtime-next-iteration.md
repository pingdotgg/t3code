# Collaborative Browser Runtime — Next Iteration

## Purpose

Turn the preview browser into a route-durable, programmable collaboration surface shared by users and agents.

The browser is not an image preview and automation is not a secondary mode. The product should own a real browser session that:

- remains alive independently of whether its panel is visible, while explicitly reporting host-renderer or window loss
- can be driven programmatically with reliable, semantic browser primitives
- can be inspected and manipulated by the user at any time
- records actions, video, console, network, and page state as reviewable evidence
- works when the development environment is remote
- can support multiple agent providers without provider-specific browser implementations

The Codex in-app browser is a strong implementation reference for shared browser ownership, hidden tab retention, browser-client ergonomics, and human/agent handoff. It is not the target product boundary. T3 should preserve its provider-neutral and remote-capable architecture and improve on Codex where those requirements demand a different shape.

This plan supersedes assumptions in:

- `.plans/visible-preview-browser-automation-via-cdp-mcp.md`
- `.plans/shared-http-mcp-server-with-preview-automation-revised.md`

Those plans remain useful implementation history, but their React-owned lifecycle, visibility-gated routing, fixed MCP command surface, and direct-only remote URL assumptions should not constrain this iteration.

The Phase 0.5 review and follow-up spikes are authoritative amendments to Phase 0:

- `.plans/browser-phase-0-5/findings.md`
- `.plans/browser-phase-0-5/006-renderer-failure-boundary.md`
- `.plans/browser-phase-0-5/007-playwright-injected-runtime.md`
- `.plans/browser-phase-0-5/008-recording-endurance.md`
- `.plans/browser-phase-0-5/009-loopback-threat-model.md`
- `.plans/browser-phase-0-5/010-human-input-interruption.md`

## Product Principles

### 1. The browser session is the product primitive

The primary object is a durable logical `BrowserSession`, not a React panel, webview component, MCP request, or screenshot. The logical record can survive host loss; the live Chromium page state cannot.

The panel is one view onto the session. Agent automation, recording, DevTools, snapshots, and user interaction all target the same session.

### 2. Human and agent use the same page

When an agent clicks, types, scrolls, navigates, or changes page state, the user must see that state when the browser is visible. When the user interacts, the agent's next observation must include the resulting state.

Do not run a hidden Playwright browser beside an unrelated visible preview and attempt to synchronize them.

### 3. Visibility is not lifecycle

Closing or switching away from the browser panel must not destroy the browser session. Visibility, focus, control ownership, process lifetime, and recording state are separate concepts.

The selected Electron `<webview>` is route-durable, not process-durable. A host-renderer reload, renderer crash, owning-window close, or application restart destroys the guest and must transition the logical tab to an explicit lost state.

### 4. Prefer existing browser automation ecosystems

Do not grow a large bespoke click/type/wait/selector framework when Playwright, CDP, and accessibility-based tooling already solve those problems.

T3 should provide session discovery, authorization, routing, collaboration state, remote access, and artifact storage. Automation adapters should translate established browser APIs onto the T3-owned session.

### 5. Remote environments are normal

A browser attached to a remote environment must be able to open services bound to that environment's loopback interface without requiring the user to manually expose a LAN address.

Remote access cannot be an afterthought or a warning-only UX.

### 6. Evidence is first-class

An agent must be able to start and stop a recording, capture screenshots, inspect console and network activity, and produce a machine-readable action trace. Evidence should be attached to the thread and usable by both the agent and user.

Video recording is an artifact and debugging tool. It is not the mechanism used to render the interactive browser UI.

## Current Architecture and Constraints

The current browser implementation already has the most important property: the human-visible Electron `<webview>` and agent automation target the same guest `WebContents`.

Current path:

```text
agent
  -> shared HTTP MCP tool
  -> environment server PreviewAutomationBroker
  -> WebSocket request to renderer owner
  -> renderer PreviewAutomationOwner
  -> Electron IPC
  -> PreviewViewManager
  -> guest webview WebContents through CDP
```

Current strengths:

- real shared browser rather than a screenshot-driven duplicate
- provider-neutral MCP entry point
- environment and thread scoped authorization
- server-side routing compatible with remote T3 clients
- schema-validated contracts and tested broker behavior
- normal browser UX including navigation, history, zoom, DevTools, and annotations

Current constraints to remove:

- browser lifetime is anchored to React component mounting
- only three hidden preview threads are retained
- sheet and route behavior can unmount the browser
- most automation requires the owner to report `visible`
- ownership is inferred from a focused renderer rather than a durable browser host
- one global persistent preview partition is shared across projects and threads
- CDP attaches and detaches around individual operations
- the custom automation surface has limited selector and locator semantics
- requests take an avoidable renderer-mediated hop before reaching desktop browser control
- remote loopback URLs are not resolved to the remote environment
- recording, trace, console, network, and download artifacts are not modeled as one system
- a browser session cannot be intentionally handed between user and agent control modes

The implementation may remove or replace these patterns rather than preserving compatibility internally. User-facing session state and existing thread behavior should be migrated deliberately.

## Target Architecture

Split the system into five boundaries:

```text
Agent adapter / skill / MCP
          |
          v
Browser Control Service  <---->  Browser Artifact Service
          |
          v
Browser Session Registry
          |
          v
Browser Host Adapter  <---->  Environment Preview Gateway
          |
          v
Real Chromium page shown in T3
```

### Browser Session Registry

The environment server owns authoritative logical session metadata:

```ts
interface BrowserSession {
  id: BrowserSessionId;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  hostId: BrowserHostId | null;
  activeTabId: BrowserTabId | null;
  lifecycle: "creating" | "ready" | "suspended" | "recovering" | "closed";
  visibility: "visible" | "hidden" | "detached";
  controller: "human" | "agent" | "none";
  partitionId: BrowserPartitionId;
  recordingId: BrowserRecordingId | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

The registry owns:

- stable session and tab identities
- environment and thread association
- lifecycle and recovery state
- host assignment
- visibility and control state
- capabilities reported by the host
- recording and artifact references
- event revisions for reconnect and stale-command rejection

The registry does not own Chromium directly. A browser host does.

### Browser Host

A `BrowserHost` is a process capable of owning and controlling real browser pages.

Initial host adapter:

- `ElectronBrowserHost`
  - uses route-durable app-level renderer-hosted `<webview>` elements
  - is mounted independently of thread routes, panel sheets, and preview components
  - registers each guest `WebContents` with the desktop main process
  - keeps desktop main authoritative for CDP, navigation, recording, and security
  - moves tabs between visible panel bounds, offscreen idle parking, and covered recording parking
  - binds each host to an owning window and reports renderer reload, renderer crash, or window close as host loss

Future host adapter:

- `EnvironmentChromiumHost`
  - runs Chromium beside a remote/headless environment
  - enables unattended testing and CI
  - is not a second browser for the same active session
  - creates a separate explicitly hosted session whose UI attachment strategy is a later phase

Do not pretend a live browser process can migrate losslessly between hosts. A session is bound to one host. Migration requires an explicit restart/restore operation and must report what state cannot be preserved.

### Browser Control Service

The control service provides one internal session-oriented API regardless of the calling agent or host implementation.

It owns:

- authorization and invocation scope
- host discovery and routing
- command serialization per tab
- cancellation, deadlines, and stale revision checks
- automation adapter sessions
- control lease and user-interruption behavior
- structured event subscriptions
- artifact creation triggers

It should expose a transport-neutral internal protocol. MCP is one adapter, not the core API.

### Browser Artifact Service

The artifact service stores and indexes:

- screenshots
- video recordings
- action timelines
- console logs
- uncaught exceptions
- network request summaries
- HAR exports where supported
- DOM/accessibility snapshots
- downloads
- optional Playwright traces

Artifacts are scoped to environment, thread, browser session, and provider session. Large payloads must not travel inline through the normal WebSocket event stream.

### Environment Preview Gateway

The gateway makes environment-local web services reachable by the browser host.

Example:

```text
remote environment localhost:5173
  -> environment TCP target
  -> dedicated authenticated WebSocket tunnel
  -> desktop loopback TCP listener
  -> real webview navigation to desktop loopback
```

The browser may load a desktop-local authority so origin paths, root-relative assets, HMR, and application WebSockets retain normal semantics. Phase 0.5 proved that a bare loopback port is not an authorization boundary, changing ports loses origin storage, and absolute redirects can escape the authority. Browser-attributed ingress, stable authority assignment, and explicit redirect/HTTPS policy are required before the gateway is production-ready. The UI separately displays the environment-relative requested target.

The gateway must support:

- raw TCP forwarding with backpressure and half-close behavior
- HTTP, streaming responses, and WebSocket upgrades without application-level rewriting
- source maps, static assets, redirects, cookies, and arbitrary root-relative paths
- deterministic target identity
- connection loss and reconnect reporting
- explicit port authorization
- one dedicated tunnel connection per accepted TCP stream initially
- a separate priority class from normal RPC and event traffic

The browser automation layer should receive both requested and resolved URLs.

## Browser Ownership and UI Model

### Move lifetime out of React

Replace `usePreviewBridge` mount/unmount ownership with explicit commands:

- `browserSession.create`
- `browserSession.attachView`
- `browserSession.detachView`
- `browserSession.setVisibility`
- `browserSession.close`

The app-level browser host remains mounted for the desktop window lifetime. React panels report display bounds and visibility intent; they do not mount, reparent, or destroy browser elements.

### Hidden browser behavior

When hidden:

- keep the webview and `WebContents` alive
- park idle tabs offscreen at their preserved viewport size to reduce compositor work
- move recording tabs to a full-size covered parking surface because offscreen tabs stop producing screencast frames
- preserve timers and network behavior by default
- allow automation and recording according to session policy
- expose an explicit low-resource suspension operation rather than silently evicting after an arbitrary count

Resource pressure policy should be observable and deterministic:

- warn before suspension
- store restorable metadata
- never silently destroy a session being controlled or recorded
- allow configurable limits by memory pressure and session activity

### Tabs

Make tabs first-class:

```ts
interface BrowserTab {
  id: BrowserTabId;
  sessionId: BrowserSessionId;
  origin: "human" | "agent" | "system";
  state: "opening" | "ready" | "closing" | "closed";
  url: string;
  title: string;
  active: boolean;
  controller: "human" | "agent" | "none";
}
```

Support:

- agent-created tabs
- user-created tabs
- selecting and listing tabs
- adopting an existing user tab
- handing a tab back to the user
- closing only tabs owned by the current workflow when requested
- restoring tab metadata after client reconnect

### Control and interruption

Use an explicit control lease instead of assuming the most recently focused owner is always correct.

Policy:

- humans may always interrupt an agent action
- active user pointer or keyboard input cancels or pauses conflicting agent input
- automation receives `BrowserControlInterruptedError`
- read-only observations may continue during human control
- the UI shows when an agent controls a tab
- agent cursor and current action are visible but do not block normal browser input
- a user can pause, resume, or revoke automation for the session

Avoid a heavyweight approval dialog for every action. Use session-level trust, site policy, and high-risk operation gates.

## Programmatic Automation

### Primary adapter decision

Do not continue expanding a fixed set of hand-written CDP operations as the main agent interface.

Implement an adapter boundary:

```ts
interface BrowserAutomationAdapter {
  connect(session: BrowserAutomationSession): Effect.Effect<BrowserAutomationConnection, BrowserError>;
}
```

Phase 0.5 selected a **Playwright-injected semantic adapter behind a T3-owned browser-client boundary**:

- persistent Electron debugger connection owned by desktop main
- the version-pinned Playwright injected runtime for selector parsing, semantic locators, shadow DOM, actionability, and hit-target behavior
- one injected runtime and execution context per frame/target, including explicit OOPIF target routing
- Playwright-like high-level semantics without Playwright owning the browser
- locator descriptions re-resolved at action time
- optional snapshot-scoped element references as ephemeral accelerators only

Direct Playwright `connectOverCDP` does not expose Electron guest targets of type `webview` as Playwright pages. A `WebContentsView` does appear as a page, but it was rejected for this iteration because hidden/detached capture failed recording requirements and its native stacking model complicates collaboration UI.

Playwright remains a behavior reference and test oracle. Its injected runtime is an internal, version-coupled dependency protected by compatibility fixtures and hidden behind T3 contracts.

### Agent-facing API

Offer multiple programmatic surfaces over the same control service:

- MCP toolkit for providers that support MCP
- skill instructions and helper client for Codex-like runtimes
- CLI for debugging and providers that can execute shell commands
- internal TypeScript client for T3 features and tests
- optional raw CDP diagnostics only in explicitly trusted developer mode

The default high-level surface should support:

- create/open/list/close sessions and tabs
- navigate, reload, history, viewport, and zoom
- semantic locate, inspect, click, hover, drag, type, select, upload, and keyboard input
- frames, dialogs, popups, downloads, and new tabs
- wait for semantic conditions, requests, navigation, and page stability
- JavaScript evaluation with bounded results
- console and exception subscriptions
- request/response observation
- screenshots and recordings
- action groups and assertions

Keep raw CDP as a privileged developer escape hatch, not the normal workflow.

### Observation model

Agents should not need a full screenshot after every action.

Provide composable observations:

- accessibility snapshot with stable element references
- semantic locator results
- bounded visible text
- viewport screenshot on demand
- current URL/title/loading state
- recent console and exception entries
- recent network failures
- DOM change summary since a known revision
- current control and recording state

Locator descriptions are the primary durable handle and must re-resolve immediately before action. Snapshot references expire on navigation, document replacement, frame replacement, HMR, or node detachment; when the originating locator is available the adapter may retry through that locator.

### Command execution

Commands to a tab are serialized unless explicitly marked read-only and concurrent-safe.

Each command includes:

- command id
- browser session and tab id
- expected session/document revision where relevant
- provider and thread invocation scope
- deadline and cancellation token
- control requirement
- artifact/evidence policy

Each result includes:

- before and after revisions
- timing
- resulting URL and title
- structured error when applicable
- references to generated evidence

## Recording, Tracing, and Debug Evidence

### Recording requirements

Agents and users can:

- start recording the active tab or browser session
- stop recording and receive an artifact reference
- mark recording chapters around action groups
- capture a short rolling buffer after a failure
- attach recordings to thread messages or task completion evidence
- download or open recordings from the UI

The browser remains a normal interactive webview while recording.

### Selected capture pipeline

Phase 0 selected:

```text
guest webview Page.startScreencast
  -> bounded frame sampler
  -> isolated recording canvas
  -> Chromium MediaRecorder
  -> H.264 MP4 artifact
```

Initial defaults:

- `video/mp4;codecs=avc1.42E01E`
- 12 frames per second
- current browser viewport with policy bounds
- dropped intermediate frames under encoder pressure instead of an unbounded queue

When a recorded tab is hidden, the durable browser host places it on a covered full-size parking surface. Moving it offscreen stops continuous screencast frames. No external ffmpeg executable is required.

CDP frame capture is internal to evidence generation. It does not replace the real browser as the interactive UX.

### Action timeline

Every recording can be paired with structured events:

```ts
interface BrowserActionEvent {
  id: BrowserActionEventId;
  sessionId: BrowserSessionId;
  tabId: BrowserTabId;
  actor: "human" | "agent" | "system";
  action: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  inputSummary: unknown;
  pageRevisionBefore: number;
  pageRevisionAfter?: number;
  screenshotBeforeId?: BrowserArtifactId;
  screenshotAfterId?: BrowserArtifactId;
  recordingOffsetMs?: number;
  error?: BrowserErrorSummary;
}
```

This timeline is more useful to agents than video alone and allows the UI to jump from an action to the relevant recording timestamp.

### Console and network capture

Maintain bounded per-tab ring buffers for:

- console entries
- uncaught exceptions
- failed requests
- response status summaries
- WebSocket connection failures
- navigation timing

Allow explicit HAR/trace recording for deeper debugging. Redact authorization headers, cookies, and configured sensitive fields before persistence.

## Remote-First Behavior

### Required remote scenarios

The design must support:

1. Desktop UI and browser on a MacBook, environment and agent on a Mac mini.
2. Desktop UI and browser local, environment inside Docker, SSH, WSL, or a cloud VM.
3. Multiple desktop clients connected to one environment without ambiguous browser ownership.
4. Agent automation continuing when the browser panel is hidden.
5. Reconnecting a desktop client to an existing logical browser session after network interruption.
6. Unattended environment-side browser sessions for CI or automated verification in a later phase.

### Preview target abstraction

Agents should open an environment-relative target rather than constructing client-reachable URLs:

```ts
type BrowserNavigationTarget =
  | { kind: "url"; url: string }
  | { kind: "environment-port"; port: number; protocol?: "http" | "https"; path?: string }
  | { kind: "run-action"; actionId: string; path?: string };
```

The environment resolves the target into:

```ts
interface ResolvedBrowserTarget {
  requested: BrowserNavigationTarget;
  displayUrl: string;
  browserUrl: string;
  resolutionKind: "direct" | "environment-gateway" | "tunnel";
  environmentId: EnvironmentId;
  expiresAt?: string;
}
```

This removes remote hostname guessing from prompts and agent logic.

### Gateway security

- do not treat loopback binding or port secrecy as authorization
- require browser-attributed ingress so unrelated pages and local processes cannot ride an authenticated environment tunnel
- keep the desktop authority stable for the granted environment/project/target tuple to preserve cookies, storage, service workers, and origin behavior
- scope gateway grants to environment, browser session, target host, and port
- use short-lived credentials inaccessible to page JavaScript where possible
- block cloud metadata and forbidden address ranges by policy
- require explicit configuration for non-loopback arbitrary upstream hosts
- validate redirects against the grant policy
- audit port openings and navigation resolutions
- do not place long-lived bearer tokens in visible URLs
- use a dedicated tunnel connection rather than the normal control/event WebSocket
- multiplex TCP streams over a bounded number of authenticated tunnel connections before T3 Connect rollout unless relay load tests prove per-stream connections safe
- define explicit compatibility behavior for absolute redirects, configured public origins, OAuth callbacks, and HTTPS upstreams

### Reconnect behavior

If the desktop connection drops:

- mark the host unavailable without deleting the logical session
- fail or pause pending control commands deterministically
- retain artifact metadata and last-known tab state
- rebind when the same browser host reconnects and reports its session inventory
- report when the underlying `WebContents` was lost and recovery requires reload

Do not claim browser process survival when the owning desktop application exited.

## Security Model

### Invocation scope

Keep the existing session-scoped MCP authentication model, generalized to browser capabilities:

- `browser:observe`
- `browser:interact`
- `browser:navigate`
- `browser:evaluate`
- `browser:record`
- `browser:network-inspect`
- `browser:raw-cdp`

The agent cannot override environment, thread, or provider session identity in normal tool arguments.

### Site policy

Add environment/user policy for:

- allowed origins and port ranges
- external internet navigation
- authentication pages
- file uploads and downloads
- clipboard access
- camera, microphone, geolocation, and notifications
- JavaScript evaluation
- raw CDP

Local development origins may be trusted by default under a configurable policy. Sensitive external origins should require an explicit trust decision.

### Browser partitions

Replace the global `persist:t3code-preview` partition with deliberate isolation.

Default proposal:

- one persistent partition per environment and project
- optional isolated partition per browser session
- explicit user action to share authentication state between sessions
- clear partition lifecycle and storage deletion UX

The final partition key must not contain raw secrets or unsafe filesystem characters.

## Contract and Module Direction

Likely contracts:

```text
packages/contracts/src/browserSession.ts
packages/contracts/src/browserControl.ts
packages/contracts/src/browserArtifacts.ts
packages/contracts/src/browserGateway.ts
```

Keep contracts schema-only.

Likely runtime modules:

```text
apps/server/src/browser/
  Services/
    BrowserSessionRegistry.ts
    BrowserControlService.ts
    BrowserArtifactService.ts
    BrowserTargetResolver.ts
  Layers/
  Rpc/
  Mcp/

apps/desktop/src/browser/
  ElectronBrowserHost.ts
  ElectronBrowserTab.ts
  CdpConnection.ts
  RecordingController.ts
  ArtifactUploader.ts

apps/web/src/browser/
  BrowserPanel.tsx
  BrowserSessionProvider.tsx
  BrowserTabs.tsx
  BrowserControlIndicator.tsx
  BrowserArtifactViewer.tsx

packages/browser-client/
  session client
  locator/action adapter
  CLI or Node helper
```

Do not preserve `PreviewAutomationOwner` as the permanent routing boundary. Replace it with browser-host registration and session attachment protocols.

## Migration Strategy

### Phase 0: Technical Spikes and Decision Records

**Status: completed.**

Authoritative results and executable spikes:

- `.plans/browser-phase-0/findings.md`
- `.plans/browser-phase-0/001-browser-host.md`
- `.plans/browser-phase-0/002-automation-adapter.md`
- `.plans/browser-phase-0/003-recording.md`
- `.plans/browser-phase-0/004-remote-preview-tunnel.md`
- `.plans/browser-phase-0/005-desktop-routing.md`
- `.plans/browser-phase-0/spikes/`

Goals:

- eliminate high-risk unknowns before reshaping contracts
- produce small executable prototypes rather than design-only conclusions

Spikes:

1. Attach Playwright or a Playwright-compatible locator runtime to the existing Electron guest webview.
2. Keep a guest `WebContents` alive and controllable while its panel is hidden and painting is reduced.
3. Record the guest content to a seekable video without replacing the interactive browser UX.
4. Proxy a remote environment's loopback HTTP and WebSocket dev server into the local desktop webview.
5. Measure CDP command latency through direct desktop routing versus the current renderer-mediated route.

Deliverables:

- decision record for automation adapter
- decision record for recording backend
- decision record for remote preview gateway transport
- measured CPU, memory, and latency results
- explicit unsupported cases

Exit criteria:

- completed: semantic role/name click and input worked against the real webview through CDP
- completed: Chromium MediaRecorder produced a seekable H.264 MP4 from covered webview capture
- completed: raw TCP tunneling carried HTTP and WebSocket traffic through a desktop loopback listener

### Phase 0.5: Production-Risk Closure

**Status: completed for the targeted desktop probes; browser-attributed tunnel ingress remains an implementation prerequisite.**

Authoritative results:

- `.plans/browser-phase-0-5/findings.md`
- `.plans/browser-phase-0-5/006-renderer-failure-boundary.md`
- `.plans/browser-phase-0-5/007-playwright-injected-runtime.md`
- `.plans/browser-phase-0-5/008-recording-endurance.md`
- `.plans/browser-phase-0-5/009-loopback-threat-model.md`
- `.plans/browser-phase-0-5/010-human-input-interruption.md`

Confirmed:

- host-renderer reload destroys the `<webview>` guest and live state, while a main-owned `WebContentsView` survives that specific reload
- Playwright's installed injected runtime can be evaluated in the real guest over CDP, resolves role/name locators through shadow DOM, and re-resolves after element replacement
- covered recording produced a seekable 1600×1200 H.264 MP4 for ten seconds at approximately 11.2 fps
- an unrelated browser page can cause a request to a loopback preview listener; loopback binding and port secrecy are not authorization
- changing the desktop port changes the browser origin and loses origin storage
- CDP keyboard dispatch did not emit Electron `before-input-event` in the tested guest

Required carry-forward:

- route-durable terminology and explicit host-loss UX
- version-pinned Playwright injected runtime with OOPIF routing and compatibility fixtures
- one-recording-per-window default until soak and concurrency budgets pass
- a browser-attributed desktop ingress design before remote preview implementation
- annotation/source attribution, port discovery, and guest isolation hardening in Phase 1
- console and network ring buffers in Phase 2

### Phase 1: Durable Browser Session Core

Goals:

- separate browser lifetime from React
- introduce stable sessions, tabs, and host registration

Tasks:

1. Add browser session, tab, host, lifecycle, and capability schemas.
2. Add server `BrowserSessionRegistry` with revisioned events.
3. Add durable app-level `ElectronBrowserHost` plus desktop-main registration and heartbeat.
4. Move browser create/close ownership out of `usePreviewBridge` and panel components.
5. Add panel-bound reporting and visible/offscreen/covered parking transitions.
6. Remove the visibility requirement from control routing.
7. Replace hidden-thread count eviction with explicit resource policy.
8. Add per-environment/project partitioning.
9. Migrate existing preview open/close state to browser sessions.
10. Preserve the annotation/element-pick/source-attribution pipeline as a Browser Control Service capability.
11. Preserve discovered-server and run-action preview UX through environment-relative target contracts.
12. Harden guest isolation and document any narrowly required main-world injection.
13. Add owning-window identity, host-loss transitions, and explicit session-loss UX.

Acceptance criteria:

- hiding the panel does not destroy the page
- automation works while hidden
- reopening shows the exact current page state
- route changes do not accidentally close the session
- desktop reconnect reports and reconciles existing browser inventory
- browser closure is always an explicit lifecycle event

### Phase 2: Control Service and Automation Adapter

Goals:

- replace fixed bespoke operations with a reusable automation connection
- preserve provider-neutral invocation

Tasks:

1. Add `BrowserControlService` with per-tab command queues and cancellation.
2. Add persistent CDP connection ownership in the desktop host.
3. Implement the selected Playwright or browser-client-style adapter.
4. Integrate the version-pinned Playwright injected runtime with locator re-resolution and compatibility fixtures.
5. Add target auto-attach, OOPIF routing, frames, popups, dialogs, downloads, drag, hover, and file upload support.
6. Add structured observation and incremental page revisions.
7. Add bounded console, exception, and network ring buffers.
8. Add a `packages/browser-client` helper and CLI.
9. Refactor MCP tools into a thin adapter over the control service.
10. Deprecate and remove redundant `PreviewAutomationOwner` operation dispatch.

Acceptance criteria:

- a provider can complete a multi-page workflow using semantic locators
- the same workflow can be driven through MCP and the browser client
- user interaction can interrupt an agent safely
- command failures identify stale page state, lost control, timeout, or host loss distinctly
- DevTools and automation coexist or fail with an explicit supported policy

### Phase 3: Remote Preview Gateway

Goals:

- make remote loopback services first-class browser targets

Tasks:

1. Add environment-port and run-action target contracts.
2. Add target resolution, stable desktop authorities, and short-lived gateway grants.
3. Implement browser-attributed desktop ingress; reject a bare unauthenticated loopback listener.
4. Implement bounded multiplexed raw TCP streams over dedicated authenticated tunnel connections.
5. Add origin, cookie, service-worker, absolute-redirect, OAuth, HTTPS, and source-map compatibility tests.
6. Integrate run actions so agents can request the declared preview target directly.
7. Display requested and resolved target information in browser diagnostics.
8. Add reconnect and expired-grant recovery.

Acceptance criteria:

- a desktop browser can open `localhost` services from a remote environment without LAN exposure
- Vite HMR works through the gateway
- application WebSockets work through the gateway
- the agent never needs to guess the remote machine's IP address
- gateway permissions cannot be reused for unrelated ports or hosts

### Phase 4: Recording and Evidence

Goals:

- make browser work inspectable, replayable, and attachable to tasks

Tasks:

1. Add browser artifact contracts and storage abstraction.
2. Add start/stop recording controls to agent and UI surfaces.
3. Add structured action timeline generation.
4. Add screenshot-before/after policies for action groups and failures.
5. Add artifact upload outside the normal WS payload path.
6. Add thread UI for video, screenshots, traces, and logs.
7. Add retention, cleanup, and size limits.
8. Add secret redaction for network and console artifacts.
9. Enforce the initial one-active-recording-per-window policy and expose encoder/drop health.

Acceptance criteria:

- an agent can record a test flow and return an artifact reference
- the user can watch the recording and jump to failed actions
- recordings work while the panel is hidden
- failed requests and console exceptions are included in the evidence bundle
- large artifacts do not block normal thread event delivery

### Phase 5: Multi-Tab Collaboration and Unattended Hosts

Goals:

- mature collaboration UX
- add optional environment-side automation without compromising shared-session semantics

Tasks:

1. Add human/agent tab origin and ownership UX.
2. Add tab adoption, handoff, finalization, and workflow cleanup policies.
3. Add visible agent cursor and current-action overlays.
4. Add session pause/revoke controls.
5. Implement `EnvironmentChromiumHost` for CI and unattended verification.
6. Define how a remote-hosted session is viewed or attached without claiming it is the local Electron webview.
7. Add capability-based host selection.
8. Add test-report integrations using browser artifacts.

Acceptance criteria:

- agent-created tabs are identifiable and cleanly handed to the user
- user-created tabs can be intentionally adopted
- unattended browser workflows use a separately identified environment-hosted session
- no workflow silently operates a second browser while presenting another as the controlled browser

## Testing Strategy

### Contract tests

- session, tab, host, control, artifact, and target schemas
- version and revision validation
- capability authorization
- invalid lifecycle transitions
- stale command rejection

### Server tests

- session registry lifecycle and event replay
- host assignment and reconnect
- per-tab command serialization
- cancellation and timeout behavior
- control lease interruption
- provider/thread isolation
- artifact metadata and cleanup
- gateway grant scoping

### Desktop tests

- webview registration cannot target unrelated `WebContents`
- hidden session remains navigable and controllable
- persistent CDP connection reconnects after navigation or target loss
- multiple tabs remain isolated
- recording starts, survives navigation, and finalizes
- resource policy never evicts active or recording sessions

### Gateway integration tests

- remote HTTP app
- Vite HMR WebSocket
- application WebSocket
- redirects
- cookies
- source maps
- upstream failure and reconnect
- forbidden host/port rejection

### End-to-end tests

1. Start a remote test environment and dev server bound only to loopback.
2. Open it through an environment-port target in the desktop browser.
3. Hide the panel.
4. Drive a semantic browser workflow through MCP or browser-client.
5. Record the workflow.
6. Reopen the panel and verify the same final page state.
7. Inspect the recording, action timeline, console, and network artifacts.

Additional scenarios:

- user interrupts agent typing
- desktop disconnects during navigation
- HMR reload occurs during locator interaction
- two desktop clients connect to the same environment
- two provider sessions cannot cross-control threads
- one provider loses authorization while another continues

Do not mock core lifecycle, routing, or command-serialization logic. External Chromium, media encoding, filesystem artifact storage, and network transport boundaries may use test layers where necessary.

## Performance and Reliability Budgets

Measure and enforce budgets rather than treating performance as qualitative.

Initial targets to validate during spikes:

- control routing overhead excluding page work: p95 under 50 ms locally, under 150 ms over a typical remote T3 connection
- hidden idle session CPU: near-zero absent page activity
- hidden session memory: observable with configurable pressure policy
- screenshot capture: under 500 ms for a normal 1280px viewport
- semantic snapshot: under 300 ms for typical application pages
- recording overhead: under 15% CPU on supported desktop hardware at the selected resolution/frame rate
- browser host reconnect detection: under 5 seconds
- no unbounded console, network, screenshot, or action buffers

Budgets may be adjusted after measurement, but the final values must be documented and covered by benchmarks or diagnostics.

## Observability

Add structured diagnostics for:

- browser session and host lifecycle transitions
- tab creation, closure, and target changes
- command queue length and duration
- CDP connection state
- control lease changes and interruptions
- gateway resolution and proxy failures
- recording start, encoder health, and finalization
- artifact sizes and upload duration
- dropped or redacted evidence

Provide a user-accessible browser diagnostics view or export so remote failures do not require reading opaque server logs.

## Explicit Non-Goals

- synchronizing two independent browsers and presenting them as one session
- replacing the interactive browser UI with JPEG or video streaming
- building a full custom Playwright clone
- preserving current internal APIs solely for compatibility
- guaranteeing browser process survival after the owning host exits
- transparent live migration of an active browser process between hosts
- unrestricted proxying to arbitrary private-network targets
- storing unlimited recordings or raw network bodies
- making Codex's browser architecture the permanent product boundary

## Pinned Phase 0 + 0.5 Decisions

1. Keep a route-durable renderer-hosted Electron `<webview>`; do not migrate to `WebContentsView` in this iteration. Explicitly model host-renderer reload, crash, and window close as live-page loss.
2. Use a T3-owned semantic CDP adapter backed initially by the version-pinned Playwright injected runtime. Do not depend on direct Playwright attachment and do not build locator/actionability semantics from scratch.
3. Record with CDP screencast plus Chromium MediaRecorder H.264 MP4 encoding. Default to one active recording per window until soak and concurrency budgets pass.
4. Keep raw TCP as the environment transport, but do not ship a bare loopback listener as the desktop authorization boundary. Require stable authorities, browser-attributed ingress, bounded multiplexing, and explicit redirect/HTTPS policy.
5. Keep the renderer as the environment transport relay initially because measured IPC overhead is negligible; remove its lifecycle authority.
6. Default browser partition scope is one persistent partition per environment and project, with optional isolated sessions.
7. Capability and site policy gates remain as defined in the Security Model section; guest isolation and the annotation/source-attribution pipeline are explicit Phase 1 requirements.
8. Artifact bytes use a dedicated storage/upload path; deployment-specific backends implement the shared artifact interface.
9. Locator descriptions re-resolve at action time. Snapshot node references are optional and ephemeral.
10. Initial controller modes are `human`, `agent`, and `none`; undefined shared control is removed.

## Recommended Implementation Order

1. Introduce session, tab, window, and host contracts from the completed Phase 0 and 0.5 ADRs.
2. Add the durable app-level webview host and desktop-main registry.
3. Move browser lifetime out of preview panels and `usePreviewBridge`.
4. Remove visibility-gated automation.
5. Add persistent CDP connections and command queues.
6. Integrate the Playwright injected runtime, per-frame routing, and semantic automation adapter.
7. Add console and network diagnostics.
8. Complete browser-attributed ingress and then add the multiplexed raw TCP environment preview tunnel.
9. Add the selected MediaRecorder evidence pipeline under the one-recording policy.
10. Add collaboration, tab handoff, and cursor UX.
11. Add optional environment-hosted Chromium sessions.
12. Remove superseded preview automation code while preserving annotations, source attribution, and discovered-server UX.

## Completion Gates

Each implementation phase must include tests for backend changes and must pass:

- `vp check`
- `vp run typecheck`
- `vp test`

Run `vp run lint:mobile` only when native mobile code changes.

The next iteration is not complete merely when an agent can click the page. It is complete when the same durable browser session can be controlled by an agent, inspected and interrupted by a user, reached from remote environments, and reviewed through reliable evidence artifacts.

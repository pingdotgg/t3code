# Web Surfaces Spec — Instance Switcher & Remote Control Action

This document is a **UI design specification** for two new surfaces introduced in Sprint 1.
It defines layout, data sources, user actions, and interaction semantics using ASCII mockups.
It does not contain TypeScript or React code.

---

## 1. Instance Switcher

### Purpose

Let the user see all live T3 instances on the current machine, switch the active client
connection to a different instance, or spawn a new named instance.

### Location

**Settings → Connections**, below the existing "Manage Local Backend" section.

Connections is the natural home because instances are an extension of the same concept as
environments: each instance is a distinct execution environment with its own backend.

---

### Data Source

The instance switcher reads the **instance registry** (Contract C1). Each entry has:

```
instanceId   — stable string identifier
name         — friendly name (from --instance flag) or null
pid          — OS process ID
port         — bound TCP port
host         — bind address (typically 127.0.0.1)
baseDir      — absolute path to this instance's isolated data directory
cwd          — working directory at launch
startedAt    — ISO 8601 timestamp
schemaVersion — integer, currently 1
```

The client fetches this via a server RPC (to be defined by HELM). Stale entries (dead PID) are
pruned server-side before the list is returned.

The currently connected instance is identified by matching the client's current `host:port` to a
registry entry.

---

### Mockup — Collapsed (default state)

```
┌─────────────────────────────────────────────────────────────┐
│ Connections                                                 │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Manage Local Backend                                  │  │
│  │  ...existing controls (network access, pairing)...   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Instances                              [+] New    [↻] │  │
│  │                                                       │  │
│  │  ● work          :3773   ~/…/work      (this window)  │  │
│  │  ○ personal      :3774   ~/…/personal                 │  │
│  │  ○ experiment    :3775   ~/…/experiment               │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Legend:**
- `●` = currently connected instance (filled dot, accent color)
- `○` = live instance not currently connected (hollow dot, muted)
- `[+] New` = opens the New Instance dialog
- `[↻]` = refreshes the registry list

Each row shows: name (or instance ID if name is null), port, truncated baseDir path, and
`(this window)` label for the active instance.

---

### Mockup — Row Action (hover/focus state)

```
│  ○ personal      :3774   ~/…/personal    [Switch]  [Open]  │
```

- **Switch** — directs the current window to reconnect to this instance's `host:port`. The
  window re-runs the standard environment-connect flow using the instance's `host:port`.
- **Open** — opens a new browser tab (web) or a new Electron window (desktop) pre-connected to
  this instance. In desktop this requires multi-window support (deferred — see sprint deliverable).

---

### Mockup — New Instance Dialog

```
┌─────────────────────────────────────────────────────────────┐
│ New Instance                                       [×]      │
│─────────────────────────────────────────────────────────────│
│                                                             │
│  Instance name                                              │
│  ┌─────────────────────────────────────────────────┐        │
│  │ my-project                                      │        │
│  └─────────────────────────────────────────────────┘        │
│  Used as both the display name and the isolated data dir.   │
│  Result: ~/.t3/instances-data/my-project                    │
│                                                             │
│  Working directory (optional)                               │
│  ┌─────────────────────────────────────────────────┐        │
│  │ ~/projects/my-project                           │        │
│  └─────────────────────────────────────────────────┘        │
│                                                             │
│                           [Cancel]  [Start instance]        │
└─────────────────────────────────────────────────────────────┘
```

**On confirm:** the client calls the server to execute `t3 start --instance <name> [<cwd>]`.
The command is the exact CLI surface from Contract C2. The dialog closes on success; the instance
list refreshes automatically. On failure the dialog stays open with an inline error.

---

### Empty State

When the registry is empty or only one instance is running and no other instances exist:

```
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Instances                              [+] New    [↻] │  │
│  │                                                       │  │
│  │  Only one instance is running.                        │  │
│  │  Start another with t3 start --instance <name>        │  │
│  │  or click New above.                                  │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
```

---

### Accessibility & Keyboard

- Tab order: list rows → each row's action buttons → New → Refresh
- Row click (not on a button) expands inline detail (port, baseDir, cwd, startedAt, pid)
- `Escape` in the New Instance dialog cancels and returns focus to the New button

---

## 2. Remote Control Action

### Purpose

Let the user launch a `claude remote-control` session from inside T3 for the selected Claude
provider instance, without leaving the app.

### Location

**Settings → Providers → Claude (expanded card)**, as a new action row at the bottom of the
expanded collapsible area, after the existing Environment variables and Models sections.

This placement is consistent with how the existing provider card already groups all actions
related to a specific provider instance.

---

### Data Source

The RC action surface consumes:

```
instanceId       — from ProviderInstanceConfig (identifies the Claude provider instance)
displayName      — shown in the section heading
claudeHomePath   — from instance.config (the "Claude HOME path" field)
binaryPath       — from instance.config (the "Binary path" field)
liveProvider     — ServerProvider (to confirm auth status before enabling the button)
```

Server-side the launcher uses `ClaudeHome` helpers to resolve the effective HOME and binary, then
spawns the RC process via the terminal Manager service (Contract C3). The UI does not need to
know binary resolution details — it just calls the RPC.

---

### Mockup — Provider Card (expanded, Claude instance)

Shown after existing sections (Display name, Accent color, Environment variables, Models):

```
  ├────────────────────────────────────────────────────────────┤
  │ Remote Control                                             │
  │                                                           │
  │  Launch this Claude account as a remote-controllable      │
  │  session you can drive from the Claude iOS or web app.    │
  │                                                           │
  │  Requires a claude.ai Pro, Max, Team, or Enterprise       │
  │  subscription.                                            │
  │                                                           │
  │  Mode:  (●) Server   ( ) Interactive                      │
  │                                                           │
  │  Session name  ┌──────────────────────────────────────┐   │
  │                │ my-work-machine                      │   │
  │                └──────────────────────────────────────┘   │
  │                                                           │
  │                             [Start Remote Control ↗]      │
  │                                                           │
  ├────────────────────────────────────────────────────────────┤
```

---

### Mockup — After Launch (status row)

Once the user clicks "Start Remote Control", the button is replaced by a status row:

```
  ├────────────────────────────────────────────────────────────┤
  │ Remote Control                                             │
  │                                                           │
  │  ● Session running  ·  Waiting for pairing from Claude    │
  │    app...                                                 │
  │                                                           │
  │  [View terminal output]          [Stop session]           │
  │                                                           │
  ├────────────────────────────────────────────────────────────┤
```

- **View terminal output** — opens (or focuses) the terminal panel that shows the raw `claude`
  process output including the pairing URL/QR code.
- **Stop session** — sends SIGTERM to the launched process via the terminal Manager.

---

### Mockup — Paired State

After pairing completes (detected when the process output contains the pairing-confirmed string):

```
  ├────────────────────────────────────────────────────────────┤
  │ Remote Control                                             │
  │                                                           │
  │  ✓ Paired  ·  Controlled from Claude app                  │
  │    Instance: work (:3773)                                 │
  │                                                           │
  │  [View terminal output]          [Stop session]           │
  │                                                           │
  ├────────────────────────────────────────────────────────────┤
```

The "Instance: work (:3773)" line links the RC session to the registry entry (C1) for the T3
instance that launched it. This is informational — it confirms which T3 instance owns this RC
process.

---

### Auth Guard

If `liveProvider.auth.status !== "authenticated"`, the "Start Remote Control" button is disabled
with a tooltip:

```
  Log in to Claude first (claude auth login) to use Remote Control.
```

If the provider is authenticated but the subscription level is unknown (the CLI can only confirm
this at runtime), the button is enabled but the descriptive text reads:

```
  Requires a claude.ai Pro, Max, Team, or Enterprise subscription.
  The session will fail to register if the account does not have a
  supported plan.
```

---

### Interaction with Multiple Instances

If multiple T3 instances are running (registry has > 1 entry), the "Instance" line in the
paired-state view shows which instance hosts the RC process. This lets the user confirm they
launched RC from the correct instance when they have e.g. a "work" and a "personal" instance open
simultaneously.

---

## 3. Cross-surface Relationship

```
Settings → Connections
  └─ Instances section
       ├─ List of C1 registry entries
       ├─ Switch / Open actions
       └─ New Instance dialog (calls t3 start --instance <name>)

Settings → Providers → Claude (expanded)
  └─ Remote Control section
       ├─ Launch button (calls terminal Manager to exec claude remote-control)
       ├─ Status row (idle / running / paired / error)
       └─ "Instance: <name> (<port>)" link back to C1 registry entry
```

The two surfaces are independent. A user can have multiple instances running (visible in
Connections) and launch Remote Control from one of them (visible in Providers). They share the
C1 registry as the common source of instance identity.

---

## 4. Deferred / Out of Scope for Sprint 1

- Actual TypeScript component code (spec-only this sprint)
- Desktop "Open new window" for an instance (requires multi-window Electron changes — deferred)
- Automatic pairing-confirmed detection (requires parsing `claude` output — can be added later;
  the terminal panel covers the interim)
- RC session persistence across T3 restarts (the process is owned by the terminal Manager; its
  lifecycle follows the terminal session)

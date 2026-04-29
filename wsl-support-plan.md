# WSL-Native Project Support For Windows In T3 Code

## Implementation Todo

### Confirmed Done

- [x] Add shared `ExecutionTarget` and `ProjectLocation` contract schemas.
- [x] Add WSL RPC contracts for distro listing, browsing, and path resolution.
- [x] Add backend WSL module for target normalization, `wsl.exe` invocation, distro parsing, UNC parsing, Windows-drive mapping, and POSIX containment helpers.
- [x] Report backend WSL capability in server config.
- [x] Persist project and provider-session execution targets with migrations/default local fallback.
- [x] Carry execution targets through orchestration project create/update/read-model flows.
- [x] Carry execution targets through provider session start/resume metadata.
- [x] Run Codex app-server through WSL for WSL projects.
- [x] Fix Codex WSL startup on Windows by bypassing `cmd.exe` for `wsl.exe` calls.
- [x] Fix Codex WSL binary resolution when Windows PATH entries appear before native WSL binaries.
- [x] Fix provider session runtime persistence for WSL execution-target metadata, including legacy double-encoded rows.
- [x] Propagate project execution targets through core web calls for terminals, git, branch selection, workspace search, and workspace writes.
- [x] Add shared command-palette "Open WSL folder" flow backed by WSL list/browse RPCs.
- [x] Remove the WSL folder-browse dependency on distro-local `node`; browse now uses POSIX shell/coreutils through `wsl.exe`.
- [x] Add focused tests for WSL path parsing, WSL CLI argument building, execution-target schemas, and web git-status target state.
- [x] Confirm Codex can respond from a WSL project in `bun run dev`.

### Active Bugs Found In Manual Testing

- [x] Fix WSL git/repository identity detection. WSL projects with git no longer show a false no-git badge.
- [ ] Fix workspace file search for WSL projects. `@` file tagging currently stays on "Searching workspace files...".
- [ ] Fix terminal open cwd handling for WSL projects. Early terminals can report `[terminal] Terminal cwd does not exist: /home/utkarsh/agents/`.
- [ ] Fix terminal close/kill for WSL PTYs. Closing terminals can log `failed to kill terminal process` for `SIGTERM`.
- [ ] Fix thread-title generation for WSL projects. It still invokes local Windows Codex against POSIX cwd and logs `C:\home\...` path failures.
- [ ] Audit provider/session reaper logs around WSL sessions to distinguish expected idle cleanup from terminal lifecycle noise.

### Lessons Learned

- WSL `executionTarget` can be present at the websocket or service boundary and still get lost later if the code relies on ambient async context. In this codebase, `AsyncLocalStorage` is not reliable across all `Effect` fiber boundaries for git flows. For WSL-sensitive operations, thread `executionTarget` explicitly through helper calls, cache keys, and refresh paths instead of assuming it can be recovered from context deeper in the stack.

### Partial / Needs Hardening

- [ ] Replace scattered target-aware conditionals with a true backend `ExecutionContext` abstraction.
- [ ] Route all workspace search/read/write operations through WSL-native execution paths; remove remaining local filesystem assumptions and any distro-local `node` dependency.
- [ ] Route git status, repository identity, branch, checkout, pull, init, worktree, and branch-create operations through WSL targets end to end.
- [ ] Add stronger typed WSL errors and user-facing error messages for missing distros, missing binaries, command timeout, and path conversion failures.
- [ ] Extend WSL provider execution beyond Codex; OpenCode is the next practical target on this machine.
- [ ] Make unsupported providers explicit for WSL projects instead of relying on local/default paths.
- [ ] Add WSL-aware checkpoint diff/store routing end to end, not just shared git primitives.
- [ ] Add setup-script and project bootstrap validation coverage for WSL projects.
- [ ] Add integration tests with mocked process spawning for WSL browse, terminal spawn args, Codex spawn args, git routing, project creation, and file writes.

### Remaining Product / UX Work

- [ ] Verify and polish the WSL open-folder flow in `bun run dev`, `npx t3`, and packaged desktop on Windows.
- [ ] Add "Open Current Folder in WSL" for Windows folders that map to `/mnt/<drive>/...`.
- [ ] Detect UNC WSL paths opened as local paths and offer to reopen them as native WSL projects.
- [ ] Display WSL project identity clearly in project picker, recent projects/sidebar, thread header, and terminal drawer.
- [ ] Add WSL path validation in the project-create flow before persistence.
- [ ] Add Windows-folder-to-WSL path conversion UI/API flow.
- [ ] Confirm terminal acceptance manually after lifecycle fixes: `pwd` shows POSIX path and `uname` reports Linux.
- [x] Confirm Codex acceptance manually from an actual WSL project.
- [ ] Confirm file search/write/git/checkpoint acceptance manually from an actual WSL project.
- [ ] Run the full required completion checks when ready: `bun fmt`, `bun lint`, and `bun typecheck`.

## Summary

Implement WSL as a first-class execution target for Windows users so T3 Code can open and operate on projects that live inside WSL without treating them as mounted Windows folders. This must work anywhere T3 Code is running with the local backend on Windows:

- packaged Electron desktop
- `npx t3`
- repo-root `bun run dev`

It does not need to work in a browser-only frontend with no local backend.

The design should follow Zed’s model closely: WSL is a distinct execution context with distro identity, POSIX paths, explicit path translation, and process execution via `wsl.exe --distribution ... --cd ... --exec ...`. Relevant Zed references indexed in Nia:

- `crates/remote/src/transport/wsl.rs`
- `crates/remote/src/remote_client.rs`
- `crates/recent_projects/src/recent_projects.rs`
- `crates/util/src/paths.rs`
- `docs/src/remote-development.md`

## Product Goal

A Windows user should be able to:

1. Open a folder already inside WSL, such as `/home/me/project`.
2. Open a Windows folder “in WSL” when it can be mapped to `/mnt/<drive>/...`.
3. Run terminals from that project inside WSL.
4. Run Codex, Claude, and other supported agents from the WSL environment, not Windows.
5. Use git, file search, file writes, checkpoints, and project setup flows against the WSL project through WSL-native tooling.
6. Reopen the app and have the same project/session continue using the same WSL target.

## Explicit Scope

### In scope

- Windows only
- Local-backend modes:
  - packaged desktop
  - `npx t3`
  - root `bun run dev`
- WSL distro discovery
- WSL folder browsing/open
- Project persistence with WSL location metadata
- WSL terminals
- WSL provider execution
- WSL file operations
- WSL git and checkpointing behavior
- Reopen/resume with persisted WSL target
- UX affordances for reopening UNC WSL paths as native WSL projects

### Out of scope

- macOS/Linux behavior changes
- Pure browser-only frontend support
- Running the entire T3 backend process inside WSL
- Remote SSH/devcontainer redesign
- Per-distro deep environment management UI in MVP
- Full support for every provider if some are not yet viable through WSL; unsupported providers may degrade to warnings

## Core Architectural Decision

Keep the backend on Windows and introduce a backend-owned execution-context layer.

Do not make Electron the owner of WSL behavior. Electron may expose convenience UI, but all WSL-aware behavior must live in `apps/server` so the same implementation works for:

- packaged desktop
- `npx t3`
- `bun run dev`

This is the key refinement from the earlier draft.

## Why This Architecture

The current repo shape already routes project-bound behavior through `apps/server`:

- provider sessions and orchestration
- terminals
- workspace search/write
- git
- checkpointing
- websocket RPC consumed by both desktop and web UI

## Public API And Contract Changes

### New contract types in `packages/contracts`

Add:

```ts
export const ExecutionTarget = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: TrimmedNonEmptyString,
    user: Schema.optional(TrimmedNonEmptyString),
  }),
);
```

Add:

```ts
export const ProjectLocation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("local"),
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: TrimmedNonEmptyString,
    user: Schema.optional(TrimmedNonEmptyString),
    path: TrimmedNonEmptyString, // POSIX path in distro
  }),
);
```

Rules:

- WSL `path` is always a POSIX path inside the distro, such as `/home/me/project`.
- Existing local projects map to `{ kind: "local" }`.

### Existing contracts to extend

Extend project/thread/session/terminal inputs and snapshots so backend consumers can distinguish local vs WSL execution. Minimum required additions:

- project create/add input
- provider session start input
- terminal open/restart input
- persisted project read model
- persisted provider session runtime
- server lifecycle/config payloads where current environment capabilities are surfaced

Do not overload plain `cwd` to imply WSL. `cwd` remains the working directory string; `executionTarget` tells us how to interpret and execute it.

### New RPCs

Add backend RPCs:

- `wsl.listDistributions`
- `wsl.browse`
- `wsl.statPath` or `wsl.resolvePath`

Suggested shapes:

```ts
wsl.listDistributions(): {
  distributions: Array<{
    name: string
    default: boolean
    running: boolean
    version?: number
  }>
}
```

```ts
wsl.browse({
  target: { kind: "wsl", distroName: string, user?: string },
  partialPath: string,
  cwd?: string,
}): FilesystemBrowseResult
```

```ts
wsl.resolvePath({
  target: { kind: "wsl", distroName: string, user?: string },
  path: string,
}): {
  path: string
  exists: boolean
  kind?: "file" | "directory"
}
```

Extend `projects.add` or equivalent project creation flow to accept `ProjectLocation`.

## Backend Modules To Add

Create a dedicated WSL backend module under `apps/server/src/wsl/`.

### `WslTarget.ts`

Defines normalized WSL target types and helpers:

- `WslTarget`
- validation/normalization
- display formatting

### `WslCli.ts`

Single authority for invoking `wsl.exe`.

Responsibilities:

- list distros with `wsl.exe --list --verbose`
- run direct commands:
  - `wsl.exe --distribution <distro> [--user <user>] --cd <cwd> --exec <program> ...`
- run shell scripts when needed:
  - `wsl.exe --distribution <distro> [--user <user>] --cd <cwd> --exec sh -lc <script>`
- convert Windows path to WSL path using `wslpath -u`
- convert WSL path to Windows path using `wslpath -w`
- structured timeout, stderr capture, truncation, and typed errors

Design constraints:

- Prefer direct `--exec` invocation over shell strings whenever possible.
- Use `sh -lc` only for compound operations.
- All calls must have bounded stdout/stderr and explicit timeouts.

### `WslPath.ts`

Responsibilities:

- parse UNC WSL paths:
  - `\\wsl.localhost\<distro>\...`
  - `\\wsl$\<distro>\...`
- return `{ distroName, path: "/..." }`
- map Windows local drive paths to `/mnt/<drive>/...`
- reject unsupported network share mappings

This should mirror Zed’s `WslPath::from_path` behavior.

### `ExecutionContext.ts`

Introduce a backend abstraction that all project-bound services use.

Shape:

```ts
interface ExecutionContext {
  readonly target: ExecutionTarget
  readonly cwd: string
  readonly pathStyle: "windows" | "posix"
  readonly runProcess(...)
  readonly stat(...)
  readonly readDirectory(...)
  readonly readFile(...)
  readonly writeFile(...)
  readonly ensureDirectory(...)
  readonly resolveChildPath(...)
}
```

Implementations:

- `LocalExecutionContext`
- `WslExecutionContext`

This is the central architectural seam. WSL support should be implemented by routing existing services through this layer rather than sprinkling `if (target.kind === "wsl")` everywhere.

## Existing Backend Areas To Refactor

### 1. Project model and persistence

Current code persists projects and sessions largely as `cwd` strings. Extend persistence to store execution target explicitly.

Add nullable `execution_target_json` columns to the relevant tables that back:

- projects
- provider session runtime
- thread/session projections where needed for denormalized reads
- terminal metadata if terminal sessions are persisted separately

Migration default for existing rows:

```json
{ "kind": "local" }
```

No existing local project behavior changes.

### 2. Workspace and filesystem services

Refactor these services to use `ExecutionContext`:

- `apps/server/src/workspace/Services/WorkspaceFileSystem.ts`
- `apps/server/src/workspace/Services/WorkspaceEntries.ts`
- any `WorkspacePaths` logic that assumes host-local paths

For WSL projects:

- browse and search within WSL
- write files through WSL
- preserve POSIX relative path behavior
- reject path traversal outside root using POSIX-aware containment rules

Do not operate on WSL projects via host UNC paths in the normal code path.

### 3. Terminal subsystem

Refactor terminal open/restart/validation to be target-aware.

For WSL targets:

- validate cwd using WSL command such as `test -d`
- spawn PTY with `node-pty` against `wsl.exe`
- pass target distro and `--cd <cwd>`
- launch shell inside WSL, not Windows shell

Shell resolution order:

1. query `$SHELL` in WSL
2. fallback `/bin/bash`
3. fallback `/bin/sh`

Terminal snapshots must keep WSL POSIX cwd strings.

### 4. Provider runtime subsystem

Refactor provider start/probe/runtime creation to accept `executionTarget`.

#### Codex

For WSL projects:

- spawn via `wsl.exe ... --exec <codex binary> app-server`
- run with WSL cwd
- use WSL `codex` binary by default
- do not feed Windows `CODEX_HOME` into WSL unless later explicitly supported as a WSL-native path setting

#### Claude / Cursor / ACP / OpenCode

Route spawn through the same target-aware path.

MVP policy:

- if a provider works via WSL command spawn, support it
- if not, mark it warning/unsupported for WSL projects with a clear provider status message
- never silently fall back to Windows execution for a WSL project
- On this machine, I have only installed Codex and OpenCode in WSL. So those are the only ones we can check and test. Try to make others also work in WSL if possible. It's ok, if not for now. Codex is our main target.

### 5. Git and checkpointing

Refactor these services to use `ExecutionContext`:

- `GitCore`
- `GitStatusBroadcaster`
- checkpoint store/diff query
- repository identity resolution
- project setup script runner

For WSL projects:

- run git inside WSL
- run checkpoint-related git plumbing inside WSL
- resolve repository identity from WSL git remotes
- run setup scripts from WSL cwd

No UNC-path git operations for normal WSL project handling.

## Frontend And Desktop UX

## Shared web UI behavior

Because backend owns WSL, most UI can be shared between desktop and web-backed local mode.

Add UI flows on Windows when backend reports WSL capability:

- “Open Folder” remains local.
- Add “Open WSL Folder” on Windows desktop.
- Add “Open Current Folder in WSL” when a local Windows folder can map to `/mnt/<drive>`.
- If user opens a UNC WSL path locally, detect it and offer to reopen as WSL.

Project labels should show target clearly, for example:

- `Ubuntu:/home/me/project`
- `WSL · Ubuntu · /home/me/project`

Display WSL projects distinctly in:

- project picker
- recent projects
- thread/project header
- terminal drawer

## Desktop-specific additions

Electron may expose convenience methods for native folder or distro selection, but these are optional UX enhancements. They must not be required for correctness.

Desktop-specific responsibilities may include:

- native Windows picker integration
- better shell/open-path handling
- reopening UNC selections as native WSL projects

## Non-desktop local mode

For `npx t3` and `bun run dev`, the UI must use backend RPCs to list distros and browse WSL paths in-app. No Electron bridge assumptions.

## Server Capability Reporting

Extend server config/lifecycle payloads to expose WSL availability on Windows.

Suggested capability:

```ts
capabilities: {
  repositoryIdentity: true,
  wsl: boolean
}
```

`wsl` is true when:

- platform is Windows
- `wsl.exe` exists and is runnable

Optionally include a richer descriptor later, but boolean is enough for MVP gating.

## Settings Behavior

Default WSL provider binaries are resolved inside the distro:

- Codex: `codex`
- OpenCode: `opencode`
- Cursor ACP if applicable: existing agent command inside WSL

MVP assumption:

- existing provider binary settings continue to apply to local/Windows execution
- WSL projects use distro-local default binary names
- per-provider per-distro WSL binary overrides are deferred

This keeps MVP smaller and avoids mixing Windows absolute paths into WSL execution.

## Error Model

Define typed WSL errors for:

- WSL unavailable
- distro list unavailable
- no distros installed
- distro not found
- path not found / not directory
- command timeout
- path conversion failure
- binary missing inside distro
- unsupported provider on WSL

UX requirement:

- include distro and high-level operation
- keep raw stderr out of primary UI surfaces
- preserve stderr in logs for debugging

## Acceptance Criteria

The feature is complete only if all of the following work on Windows:

### Mode coverage

- packaged desktop
- `npx t3`
- root `bun run dev`

### Project flows

- user can open a WSL folder through product UI
- project persists as WSL project
- reopening app/session keeps same WSL target
- UNC WSL path is detected and offered native reopen

### Terminal flows

- opening a thread terminal in a WSL project launches inside the distro
- `pwd` shows the WSL path
- `uname` reports Linux
- commands execute inside WSL

### Provider flows

- starting Codex in a WSL project launches Codex from WSL
- provider resume continues using the same WSL target
- unsupported providers do not silently run on Windows

### File and git flows

- project search works against WSL files
- project file writes modify WSL files
- git status/checkpointing operate correctly from WSL
- setup scripts run in WSL

## Test Plan

### Unit tests

Add tests for:

- WSL UNC path parsing
- Windows-to-WSL path mapping
- rejection of unsupported network shares
- `WslCli` command builder output
- POSIX root containment/path traversal checks
- execution target schema encode/decode
- persistence round-trip for WSL target metadata

### Integration tests with mocked process layer

Use existing process abstractions or add a mockable seam around `wsl.exe` calls.

Test:

- distro discovery
- WSL browse path resolution
- WSL project creation persistence
- terminal spawn argument construction
- Codex spawn argument construction
- git command routing to WSL
- file write routing to WSL

## Rollout Plan

### Phase 1: Backend foundation

- add contracts
- add WSL backend module
- add execution context abstraction
- add persistence schema/migrations
- add capability reporting

### Phase 2: MVP end-to-end

- WSL project open flow
- WSL terminal support
- Codex WSL runtime support
- WSL workspace browse/search/write
- WSL git/checkpointing

### Phase 3: polish and extension

- UNC reopen UX
- recent project polish
- provider support expansion
- optional per-distro overrides if needed

## Assumptions And Defaults

- Windows only for MVP
- backend-owned implementation, not desktop-owned
- packaged desktop, `npx t3`, and root `bun run dev` are all required to work
- browser-only frontend with no local backend is explicitly unsupported
- WSL projects always use POSIX cwd values
- existing local projects default to `{ kind: "local" }`
- WSL binaries default to distro-local command names
- unsupported providers on WSL show warnings rather than falling back to Windows execution

You can look at Zed for reference using Nia. It would have been better to look at VS Code because it's also an electron app, but its WSL extension is not open-sourve. So, check Zed whenever needed or you are confused about how to do something or the implementation. If you are checking, and Nia usage gets over, don't assume anything to continue, instead stop and tell me.

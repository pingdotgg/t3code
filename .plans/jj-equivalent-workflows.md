# jj Equivalent Workflows Plan

Status: Phases 0-10 implemented locally; required repository validation passes

Scope: server, shared contracts, web, mobile, provider integrations, tests, and documentation

Target: Git-backed, colocated Jujutsu repositories first

## Goal

Give a repository selected as `jj` the same product outcomes currently available for Git:

- initialize, clone, publish, and discover a repository;
- show source-control status and diffs;
- create an isolated thread workspace;
- start, describe, and finalize a change;
- push a named ref and create a pull request;
- fetch remote updates safely;
- check out a pull request into the current workspace or a new one;
- capture, preview, and restore T3 Code checkpoints;
- recover predictably from interrupted commands, stale workspaces, and conflicts.

Equivalence means equivalent user outcomes, not translating every Git command literally. jj has no staging index or current bookmark, its working copy is a commit, and conflicts can persist in commits. The product model must expose those semantics instead of pretending jj is Git.

## Initial support boundary

The first release supports Git-backed jj repositories in colocated mode.

This boundary preserves:

- GitHub, GitLab, and Bitbucket remote compatibility;
- provider CLI behavior that expects a `.git` directory;
- existing agents and tools that may still invoke Git;
- a low-risk migration path for existing repositories.

Pure jj repositories and non-colocated Git-backed repositories are later work. Commands must still go through the jj driver; direct Git calls are allowed only inside explicitly documented provider compatibility adapters.

Repository selection rules:

1. An explicit `.t3code/vcs.json` selection wins.
2. In automatic mode, `.jj` wins over `.git` so a colocated repository is treated as jj.
3. A repository with only `.git` remains Git.
4. An explicit unsupported selection returns a useful configuration error; it must not silently mutate the repository with another VCS.

## Semantic mapping

| Product concept | Git implementation | jj implementation |
| --- | --- | --- |
| Repository | Git working tree | jj workspace backed by Git |
| Thread isolation | Git worktree | `jj workspace` |
| Named publish ref | Branch | Bookmark |
| Current location | Checked-out branch and `HEAD` | Workspace commit `@`; optional publish bookmark is separate |
| Uncommitted work | Working tree and index | Mutable working-copy commit |
| Commit action | Create a commit from staged or selected files | Describe/finalize the current change, then create a new working-copy change |
| Select files | Git index/pathspec commit | jj fileset arguments to `jj commit` |
| Switch base | Checkout/switch branch | Create a new change on a revision, or explicitly edit an existing change |
| Pull | Fetch plus fast-forward | Fetch tracked bookmarks; advance/rebase only when safe |
| Push | Push branch | Move and push one explicit bookmark |
| Remote branch | Remote-tracking branch | Remote bookmark such as `main@origin` |
| Recovery snapshot | Hidden Git checkpoint refs | jj operation and working-copy revision metadata, restored locally |
| Merge conflict | Transient index/worktree state | First-class conflicted revision or bookmark |

Two product concepts must remain separate:

- `workspaceRevision`: the change currently edited by a workspace;
- `publishRef`: the bookmark deliberately moved and pushed for a change request.

There is no “current bookmark” in jj. UI and server code must never infer a publish bookmark merely because it points at `@`.

## Architecture direction

Do not add jj branches throughout `GitManager`. Extract workflow-level VCS services, then implement Git and jj adapters behind them.

Keep `packages/contracts` schema-only. Put process execution and semantic mapping in server packages.

Proposed server boundaries:

- `VcsRepositoryService`: detection, initialization, clone, remotes, files, ignored paths;
- `VcsStatusService`: status, revisions, refs, divergence, conflicts, diffs;
- `VcsWorkspaceService`: create, reuse, list, repair, and forget isolated workspaces;
- `VcsChangeService`: describe, finalize all or selected files, generate message context;
- `VcsSyncService`: fetch, advance/rebase safely, move a publish ref, and push;
- `VcsCheckpointService`: capture, diff, restore, and expire checkpoints.

Each service resolves a driver through `VcsDriverRegistry`. Provider services depend on these workflow interfaces, not on `GitVcsDriver`.

Avoid one oversized driver interface. Capabilities should describe real semantic support, including:

- `supportsWorkspaces`;
- `supportsNamedPublishRefs`;
- `supportsSelectedFileFinalize`;
- `supportsAtomicSnapshot`;
- `supportsThreadLocalRestore`;
- `supportsDefaultRemotePush`;
- `supportsGitProviderCompatibility`.

## Delivery phases

### Phase 0: command and data contract spike

Implementation status: implemented locally; cross-platform verification runs in CI. See `docs/architecture/jj-command-contract.md` and `scripts/jj-phase-zero-smoke.ts`.

Build a disposable fixture matrix before changing production behavior.

Tasks:

- choose and document a minimum supported jj version;
- test the command surface against that version and the current stable version;
- prove `jj git init --colocate` and `jj git clone --colocate` on macOS, Linux, and Windows;
- define machine-readable templates for status, log, bookmarks, workspaces, and operation IDs;
- use explicit templates and safe delimiters; never parse colored or human-formatted output;
- test paths, bookmark names, and descriptions containing spaces, Unicode, tabs, and newlines;
- classify exit codes and stderr for missing binary, non-repository, stale workspace, unresolved revision, bookmark conflict, content conflict, authentication, and rejected push;
- prove a durable, thread-local checkpoint restore strategy without restoring the entire repository operation state.

Exit criteria:

- a checked-in command mapping document or test fixture records every command used later;
- the checkpoint experiment survives process restart and jj garbage collection within the promised retention window;
- unsupported jj versions fail during discovery with an actionable message.

### Phase 1: make workflow contracts VCS-neutral

Implementation status: implemented locally. Generic contracts, legacy Git RPC aliases, persisted-thread compatibility fields/tests, and provider Git compatibility boundary are in place.

Replace Git-shaped shared models before implementing jj behavior.

Tasks:

- introduce generic status models with `workspaceRevision`, optional `publishRef`, default ref, tracked remote state, conflicts, and divergence;
- replace branch-only identity with a named-ref type carrying `kind: "branch" | "bookmark"`;
- replace worktree-only identity with workspace identity while retaining a migration reader for stored Git threads;
- add generic change, workspace, sync, and checkpoint errors to `packages/contracts`;
- introduce `vcs.*` RPC methods for generic workflows;
- retain `git.*` RPC aliases temporarily so old clients can reconnect during rollout;
- move progress phases and messages to VCS-neutral events, with driver-specific user labels supplied separately;
- update persistence schemas with forward and backward migration tests.

Exit criteria:

- Git behavior is unchanged through the new interfaces;
- no provider, review, or source-control service needs to import `GitVcsDriver` directly;
- old persisted Git threads still open.

### Phase 2: implement the jj process and repository driver

Implementation status: implemented locally. `JjProcess`, `JjVcsDriver`, registry preference, init UI, and real Git/jj driver contract tests are in place.

Add `JjProcess` and `JjVcsDriver` using the same timeout, cancellation, redaction, output-limit, and error-mapping standards as Git.

Tasks:

- discover the binary and supported version;
- detect `.jj`, resolve repository/workspace roots, and detect colocation;
- implement file listing and ignored-path filtering;
- implement remote list/add/remove and default-remote selection;
- initialize an existing directory with `jj git init --colocate`;
- clone with `jj git clone --colocate`;
- register the driver and mark jj discovery as implemented;
- add the jj driver to all server layer graphs;
- ensure automatic detection prefers jj in a colocated repository.

Exit criteria:

- the shared driver contract suite runs against temporary Git and jj repositories;
- initialization and clone never choose jj unless configuration or detection says jj;
- command cancellation cannot leave an unobserved child process.

### Phase 3: status, refs, revisions, and diffs

Implementation status: implemented locally.

Model jj state directly.

Tasks:

- snapshot before status-sensitive reads so filesystem changes are represented;
- report the workspace commit ID, change ID, description, parents, emptiness, and content conflicts;
- list local and remote bookmarks, tracking state, divergence, and bookmark conflicts;
- identify a default remote bookmark without treating it as a current bookmark;
- calculate changed files and patch data from the working-copy revision;
- support working-copy, base-to-publish-ref, turn, and arbitrary checkpoint diffs;
- preserve rename, binary-file, mode, and deletion metadata expected by review UI;
- cap and stream large patches consistently with Git;
- keep line comments keyed to stable diff identity rather than a branch name.

Suggested command shapes, validated in Phase 0:

- status metadata: `jj log` and `jj bookmark list` with explicit templates;
- working-copy patch: `jj diff --git -r @`;
- range patch: `jj diff --git --from <base> --to <target>`;
- explicit snapshot: `jj util snapshot` when a read path otherwise would not snapshot.

Exit criteria:

- the web and mobile clients render jj status without a fictional active branch;
- conflicted changes and conflicted bookmarks are distinct states;
- equivalent Git and jj fixtures produce equivalent review file lists.

### Phase 4: thread workspaces

Implementation status: implemented locally. Thread bootstrap and generic workspace RPCs now route
through `VcsWorkspaceService`; JJ workspaces use deterministic thread names, persisted revision/base
identity, stale repair, idempotent recreation, and forget-before-delete cleanup. Git worktrees retain
their existing behavior through the same service.

Replace worktree assumptions with a generic isolated-workspace workflow.

Tasks:

- create a deterministic jj workspace name from the T3 Code thread ID;
- create the directory with `jj workspace add` at the requested base revision;
- start a new empty change on that base rather than editing a published revision;
- store workspace name, root path, current change ID, base revision, and optional publish bookmark in thread metadata;
- reuse an existing valid workspace on reconnect;
- detect and repair stale workspaces with `jj workspace update-stale` only after showing the intended recovery action in logs;
- forget workspace metadata before deleting a workspace directory;
- handle missing directories, duplicate names, interrupted creation, and external workspace rewrites idempotently;
- preserve Git worktree behavior through the same interface.

Exit criteria:

- two threads can edit separate jj workspaces concurrently;
- restarting the server reconnects each thread to the correct workspace/change;
- deleting one thread cannot change or forget another workspace.

### Phase 5: change finalization and AI messages

Implementation status: implemented locally. JJ actions now use `@` patch context, support custom or
AI-generated messages, finalize all or selected files, preserve excluded edits in the new `@`, and
return both finalized and workspace revisions. A publish bookmark is created only when the existing
feature-ref option explicitly requests one; no remote publish occurs.

Implement the current commit workflows with jj-native behavior.

Tasks:

- generate AI message context from the patch for `@`;
- describe and finalize all files with `jj commit -m <message>`;
- finalize selected files using validated jj fileset arguments;
- leave non-selected changes in the new working-copy change;
- return the finalized revision and the newly created workspace revision explicitly;
- create or move a publish bookmark to the finalized revision only when the workflow requests publishing;
- implement “create feature ref” as creating a bookmark, not as changing workspace attachment;
- reject an empty message and distinguish an empty finalized change from a successful finalize;
- preserve streamed progress and cancellation.

The product should label this action contextually:

- Git: “Commit”;
- jj: “Finalize change” or “Commit change”.

Do not emulate the Git index. Do not silently run Git commit hooks: their index semantics do not match jj selected-file finalization. If project validation is required, expose it as a separate, VCS-neutral validation step with visible output.

Exit criteria:

- custom, AI-generated, all-file, and selected-file workflows work in both drivers;
- selected-file finalization preserves excluded changes;
- no finalized revision is pushed until an explicit publish action.

### Phase 6: fetch, publish, and change requests

Implementation status: implemented locally. JJ fetch now returns structured safe-advance,
needs-rebase, and needs-resolution outcomes. Publish actions require one explicit bookmark, move it
to the selected finalized revision, push only that bookmark without force, and use it as the change
request head. Hosted repository creation adds a JJ remote before the same exact-bookmark publish.

Make remote mutation explicit and conservative.

Tasks:

- implement fetch as `jj git fetch --remote <remote>`;
- refresh tracked bookmarks and return bookmark conflicts as structured state;
- after fetch, automatically advance an empty workspace change only when the old base is safely superseded;
- if the workspace change is non-empty, divergent, or conflicted, leave it untouched and return `needsRebase` or `needsResolution`;
- move one explicit publish bookmark to the selected finalized revision;
- push only that bookmark with `jj git push --remote <remote> --bookmark <name>`;
- never use an implicit “push all bookmarks” operation;
- use the publish bookmark as the provider pull-request head;
- derive provider identity from normalized remotes through the generic repository service;
- keep provider CLI compatibility isolated to colocated repositories;
- create/publish a new hosted repository by creating the provider repository, adding the jj Git remote, and pushing the explicit bookmark;
- map authentication and push-safety failures to actionable errors without automatic force.

Stacked action mapping:

1. Snapshot and validate the working-copy change.
2. Finalize it with a message.
3. Create or move the publish bookmark to the finalized revision.
4. Push exactly that bookmark.
5. Create or update the provider pull request.
6. Leave the workspace on a new empty change above the finalized revision.

Exit criteria:

- commit-only, commit-and-push, and commit-push-PR modes reach the same user-visible outcomes as Git;
- a rejected or conflicted push never overwrites remote work;
- fetch never rewrites a non-empty workspace change automatically.

### Phase 7: pull-request checkout

Implementation status: implemented locally. Provider change-request checkout now routes colocated
jj repositories through a dedicated review service. It creates a deterministic review bookmark,
starts an empty local change or isolated workspace from the published head, reuses repeated
checkouts, and adds fork remotes without moving the published revision.

Implement review checkout without editing published history accidentally.

Tasks:

- fetch the provider PR head into a deterministic local bookmark;
- support checkout into the current workspace by creating a new empty change on the PR head;
- support checkout into a new thread by creating a jj workspace on the PR head;
- add cross-fork remotes through the generic remote service;
- make repeated checkout idempotent;
- preserve the PR bookmark separately from any future publish bookmark for review edits;
- clean up temporary PR bookmarks/remotes only when no thread references them.

Exit criteria:

- GitHub, GitLab, and Bitbucket checkout fixtures work for same-repository and fork pull requests;
- opening a PR for review does not mutate its published revision;
- current-workspace and isolated-workspace modes behave consistently.

### Phase 8: checkpoints and rollback

Implementation status: implemented locally. JJ checkpoints snapshot `@`, retain its commit through
hidden Git refs, store operation/revision metadata in hidden blob refs, diff recorded commits, and
restore content plus description with jj-native commands. Capture/delete update retention anchors
through the generic checkpoint driver contract; repository-wide operation restore is never used.

Use jj’s snapshot and operation model, but keep rollback thread-local.

Tasks:

- run an explicit snapshot and record operation ID, workspace name, commit ID, change ID, parents, and description;
- compute checkpoint previews between recorded revisions;
- restore file contents and description into the selected workspace revision;
- never use repository-wide `jj op restore` for a thread rollback;
- define checkpoint retention and prove recorded revisions remain addressable for that duration;
- expire checkpoint metadata and any retention anchors together;
- detect when a checkpoint belongs to another repository/workspace and refuse restore;
- serialize restore against other mutations in the same workspace while allowing independent workspaces to proceed;
- retain the Git hidden-ref implementation behind the same contract.

If jj cannot provide durable revision retention without exporting unwanted refs to Git, checkpoint parity blocks jj general availability. Do not hide this limitation behind `supportsAtomicSnapshot`.

Exit criteria:

- checkpoint capture, preview, restart recovery, and restore pass for Git and jj;
- restoring one thread does not move bookmarks or other workspaces;
- interrupted restore yields a recoverable structured state.

### Phase 9: client semantics and settings

Implementation status: implemented locally. Shared client-runtime presentation selectors provide
Git branch/worktree and jj bookmark/workspace language to web and mobile. PR checkout, source-control
progress, version-control settings, and mobile ref/workspace surfaces use the detected driver while
keeping compatibility RPC field names unchanged.

Expose capabilities and jj terms without duplicating whole clients.

Tasks:

- rename generic surfaces from “Git” to “Source control” where both drivers apply;
- show “branch” for Git and “bookmark” for jj;
- show “worktree” for Git and “workspace” for jj;
- show workspace change and publish bookmark as separate fields;
- replace “Pull” with a driver-provided label; jj should normally say “Fetch updates” and show a separate rebase action when needed;
- add content-conflict and bookmark-conflict indicators;
- disable unsupported actions from capabilities with a reason, not by hiding repository state;
- add repository selection and detection details to settings;
- update web first, then mobile using shared client-runtime selectors and labels;
- migrate `git.*` client calls to `vcs.*`, then remove compatibility aliases after one release window.

Exit criteria:

- no jj screen claims there is a checked-out branch;
- the same state produces the same enabled actions in web and mobile;
- Git terminology and behavior remain unchanged for Git repositories.

### Phase 10: rollout, observability, and documentation

Implementation status: implemented locally. Workflow spans carry only safe VCS kind/workflow/operation
attributes, user setup and recovery documentation is published, colocation limits are explicit, and
pure/non-colocated jj support has a separate proposal. The initial mutation gate is considered
graduated because workspace, provider, and durable-checkpoint criteria now pass; no permanent gate
is retained in the completed implementation.

Ship progressively.

Tasks:

- gate jj mutation workflows behind an experimental setting initially;
- allow read-only status/diff before mutation workflows are enabled;
- record operation duration, cancellation, failure class, VCS kind, and workflow name without recording paths, messages, patches, or remote credentials;
- add recovery logs containing repository-safe IDs and suggested commands;
- publish setup, conversion, supported-version, limitations, and recovery documentation;
- document colocation implications for users and agents that also run Git;
- remove the experimental gate only after checkpoint, provider, and concurrent-workspace criteria pass;
- plan pure/non-colocated jj support as a separate proposal.

Exit criteria:

- a user can complete the full acceptance matrix below using jj without a Git-only escape hatch;
- support docs identify every intentional semantic difference;
- failure telemetry shows no unclassified jj command failures in the beta cohort.

## Workflow acceptance matrix

| Workflow | Required jj outcome |
| --- | --- |
| Detect | Colocated `.jj` repository resolves to jj; explicit config overrides auto-detection |
| Initialize | Existing directory becomes a colocated Git-backed jj repository |
| Clone | Hosted Git repository becomes a colocated jj workspace with tracked default bookmark |
| Publish new repo | Provider repo and remote are created; one explicit bookmark is pushed |
| Status | Changed files, workspace revision, publish bookmark, divergence, and conflicts are accurate |
| New local thread | New empty change is created from the chosen base in the current workspace |
| New isolated thread | New jj workspace and empty change are created from the chosen base |
| Finalize all | Current change is described/finalized; workspace moves to a new empty change |
| Finalize selected | Selected files are finalized; excluded files remain in the workspace change |
| AI message | Message context comes from the current change patch and follows existing confirmation rules |
| Push | Only the chosen publish bookmark moves remotely; safety rejection is preserved |
| Fetch updates | Remote bookmarks update; unsafe local rebase is not automatic |
| Create PR | Provider PR head is the explicit publish bookmark |
| Checkout PR | PR head becomes the base of a new local change in current or isolated workspace |
| Review | Working-copy and range diffs support file navigation and line comments |
| Checkpoint | Capture and preview survive restart for the documented retention window |
| Restore | Only the target workspace contents/description change |
| Recovery | Stale workspace, interrupted command, and conflicts return structured next actions |

## Test strategy

### Contract tests

- Run shared repository, status, workspace, change, sync, diff, and checkpoint suites against both drivers.
- Require every optional capability to have both a positive test and an unsupported-path test.
- Keep Git regression fixtures while jj is added.

### Real CLI integration tests

- Install the minimum supported jj version in CI.
- Test initialization, clone, workspace concurrency, selected files, fetch divergence, bookmark conflicts, content conflicts, push rejection, stale workspace recovery, checkpoint retention, and cancellation.
- Use local bare Git remotes; provider network tests remain separate.
- Cover paths and messages with spaces, Unicode, and newlines.

### Server tests

- Test registry selection, layer wiring, RPC compatibility, persistence migration, command serialization, redaction, and error mapping.
- Use fake provider APIs for create, publish, and PR checkout orchestration.
- Verify no generic service imports a concrete Git or jj driver.

### Client tests

- Test capability-derived labels and enabled actions.
- Test separate workspace revision/publish bookmark rendering.
- Test conflict and needs-rebase states in web and mobile.

### End-to-end scenarios

1. Clone, create isolated thread, edit, finalize, push, create PR.
2. Finalize selected files while retaining excluded changes.
3. Fetch a remote advance with an empty workspace change.
4. Fetch a remote advance with local work and require explicit rebase.
5. Check out same-repo and fork PRs into new workspaces.
6. Capture, restart server, preview, and restore a checkpoint.
7. Run two workspaces concurrently and recover one stale workspace.
8. Trigger content and bookmark conflicts and verify safe, actionable UI.

Before each implementation slice is complete, run the focused tests plus repository-required `vp check` and `vp run typecheck`. Native mobile slices also require `vp run lint:mobile`.

## Migration order

Land work as small vertical slices:

1. Generic contracts and Git adapter with no behavior change.
2. jj detection, repository operations, and read-only status.
3. jj diffs and review.
4. jj thread workspaces.
5. jj finalize and selected-file workflows.
6. jj fetch and explicit bookmark push.
7. provider PR create/checkout.
8. durable checkpoints and restore.
9. mobile parity, migration cleanup, and removal of `git.*` aliases.

Each slice must be independently releasable behind capabilities or the experimental gate. Do not land client controls before the server reports the matching capability.

## Main risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Git-shaped contracts force incorrect jj behavior | Separate workspace revision from publish ref before driver work |
| Human CLI output changes between jj versions | Pin minimum version; use explicit templates; integration-test current stable |
| Colocated Git and jj commands race | Serialize repository mutations; snapshot/import at workflow boundaries; document colocation |
| Operation restore affects every workspace | Never use repository-wide restore for thread rollback |
| Checkpoint revisions are garbage-collected | Prove and implement bounded retention before claiming support |
| Fetch creates bookmark divergence/conflict | Return structured state; never auto-force or auto-resolve |
| Provider tools assume Git branch state | Pass explicit repo/head data; isolate provider CLI compatibility adapters |
| Selected-file commit differs from Git staging | Use jj filesets and test excluded-change preservation |
| Stale workspace after cross-workspace rewrite | Detect and expose repair; test interruption and recovery |
| Git hooks do not map to jj | Use an explicit VCS-neutral validation workflow; do not emulate the Git index |

## Non-goals for first release

- a full jj operation-log or revset UI;
- arbitrary history editing, absorb, squash, split, or stack-management UI;
- automatic conflict resolution;
- pure jj or non-colocated Git-backed repositories;
- Git index or Git commit-hook emulation;
- changing provider APIs beyond what generic VCS orchestration requires;
- automatically publishing every bookmark;
- silently converting an existing Git repository to jj.

## References

- [jj working copy and workspaces](https://docs.jj-vcs.dev/latest/working-copy/)
- [jj bookmarks and remote tracking](https://docs.jj-vcs.dev/latest/bookmarks/)
- [jj CLI reference](https://docs.jj-vcs.dev/latest/cli-reference/)
- [jj conflict model](https://docs.jj-vcs.dev/latest/conflicts/)

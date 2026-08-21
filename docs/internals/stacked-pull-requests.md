# Stacked Pull Requests

## Goal

Add GitHub stacked pull requests to T3 Code without replacing the current pull request or Git workflows. A user should be able to create, view, review, update, hand to an agent, and merge a stack without learning stack-specific Git terms.

## Product language

- **Stack** means the full ordered group of dependent pull requests.
- **Step** means one branch and its pull request inside the stack.
- User-facing copy says **step** for normal actions. Terms such as `upstack`, `downstack`, and `restack` stay out of primary UI.
- The base branch appears below the first step.

## Product model

A stack wraps the current pull request experience. It does not replace it.

The Pull Requests page and right panel continue to show one selected pull request. A small stack bar above the existing detail panel shows:

- Current position, such as `Step 3 of 5`.
- Stack state, such as `4 open` or `2 later steps need refresh`.
- A popover with every step in order and the base branch at the bottom.
- A merge action whose label states its exact scope, such as `Merge through step 3`.

Selecting another step changes the selected pull request. Existing detail actions stay scoped to that pull request:

- Title, description, reactions, comments, and reviewers.
- Summary, timeline, commits, and code review.
- Draft, ready, close, and reopen.
- Ask, explain, fix findings, resolve conflicts, and checkout.

Closing, updating, or merging only an earlier step explains that later steps may need refresh.
Actions that update the full stack say so before they run.

## Main flows

### Start a stack

`Start stack` adopts the current non-default branch. The existing commit control remains the only commit UI.

### Add a step

`Start next step` creates and checks out one branch above the current top step. The user then commits through the existing Git control.

### Share a stack

`Share stack` runs the official non-interactive GitHub stack submit flow. New pull requests are drafts. The final state is read back before T3 reports success.

### Refresh a stack

`Refresh stack` synchronizes the stack with its base. The CLI error stays visible when a
conflict needs manual work. Existing pull request agent actions remain available. T3 does not
report success when GitHub reports a diverged stack without changing it.

### Review a stack

The current pull request remains the review unit. The stack bar provides previous and next navigation. After a review is submitted, `Review next step` selects the next open pull request.

### Merge a stack

The normal single-PR merge button becomes `Merge through step N` for a stacked pull request. Confirmation lists every included pull request. GitHub performs the merge. T3 reports direct merge, queued, or failed state without promising atomic queue landing.

### Unstack

`Unstack` is an overflow action with confirmation. It removes stack links but does not delete pull requests, branches, threads, or worktrees.

## Architecture

GitHub's official `gh stack` extension owns local stack metadata and Git history operations. GitHub's Stacks REST API owns remote stack membership. T3 owns typed contracts, access control, progress state, presentation, and agent handoff.

The first implementation is GitHub-only. Clients hide stack actions for other source-control
providers. No provider registry is added until a second provider has a real stack implementation.

### Contracts

A new `pullRequestStack.ts` module defines:

- Remote stack summaries and ordered remote steps.
- Current local stack and ordered local steps.
- Availability and not-in-stack states.
- Inputs and results for start, add, submit, sync, merge, and unstack.
- A typed stack error with operation, working directory, and command detail.

Existing `GitStackedAction` remains unchanged because it represents one commit/push/create-PR workflow, not stacked pull requests.

### Server

One concrete GitHub stack service uses existing process and GitHub CLI runners.

- `gh api repos/{owner}/{repo}/stacks --hostname <host>` reads remote stacks once per project,
  including GitHub Enterprise hosts.
- `gh stack view --json` reads the current local stack.
- `gh stack init`, `add`, `submit --auto`, `sync`, `merge --yes`, and `unstack` perform mutations.
- Exit code `2` from `view --json` means the branch is not in a stack. Other non-zero exits remain errors.
- Local mutations refresh current stack data before returning. Merge returns the CLI status, then
  the client refreshes pull request details.

RPC authorization follows existing rules: reads need project read access; mutations need operate access.

### Shared client state

Client-runtime owns per-project remote stack state and per-working-directory local stack state. Web and mobile use the same action state.

### Web

- Git actions add start, next, share, refresh, and unstack without changing normal commit/push actions.
- Branch toolbar shows `Step x of y` only for a current stack.
- Pull request rows show stack position. Members remain ordinary selectable rows.
- Pull request detail adds the stack bar and popover above existing content.
- Existing detail tabs and actions remain unchanged and scoped to the selected step.
- Command palette exposes view stack, next step, share, and refresh when valid.
- Source-control settings reports whether `gh stack` is installed and whether the repository supports stacks.

No separate Stacks page is added.

### Mobile and desktop

Mobile Git overview shows current stack, steps, and the same core actions. Pull request review still opens externally because mobile has no full in-app PR review surface.

Desktop inherits the web UI. No desktop-only stack domain is added.

### Agents

One step maps to one existing PR thread/worktree handoff. Agent actions always name the selected step. After a lower step changes, later steps show stale state and the user can refresh them. Provider-specific prompt changes are not required.

## Failure states

- Missing `gh stack`: show install command; keep normal PR flow usable.
- GitHub stacks unavailable: explain repository support; do not fall back to fake stacks.
- Not in a stack: return normal empty state, not an error toast.
- Sync conflict: show the CLI detail and keep existing pull request agent actions available.
- Diverged local and remote stacks: stop and explain that no changes were made.
- Partial submit: show the CLI detail and keep the submit action available for retry.
- Merge failure: show GitHub's safe message; no pull request is reported merged without fresh state.

## Performance and accessibility

- One remote stack request per project, never one request per pull request.
- Local stack reads follow current branch changes and explicit refreshes.
- Static connector lines; no continuous animation.
- Status always includes text or an icon label, never color alone.
- Keyboard focus, screen-reader names, and current-step state are required.
- Mobile controls keep a 44-by-44-pixel minimum target.

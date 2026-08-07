# Agents

Agents are reusable orchestration profiles. A profile gives a model a role, instructions, a default model, permissions, tools, rules, hooks, delegation limits, and a work budget. The model in the main chat can then launch other profiles as child agents without depending on provider-specific subagent features.

## Create a profile

Open **Settings → Agents**, choose an environment or project, and select **New profile**.

- Environment profiles are available to every project hosted by that environment.
- Project profiles belong to one project and can be checked into the repository with its `t3.json` configuration.
- A profile's model may come from any configured provider instance. The parent and child do not need to use the same provider.

New profiles start in **Auto** runtime mode. Choose a more permissive mode explicitly when the work requires it; existing profiles keep their configured mode when edited.

The profile editor exposes conservative limits. One orchestration lineage can have at most 32 runs, 8 concurrent runs, 4 delegation levels, and 120 minutes of wall time. A child can lower a parent's remaining budget but cannot raise it.

Archive hides a profile without deleting its document. Archived profiles can be restored.

Enable **Show in chat Agent picker** for profiles users should be able to start directly. Turn it off for planners, reviewers, or other specialists that should only be launched through another Agent's delegation policy. This setting changes discovery in chat only; it does not disable the profile or remove it from an orchestrator's allowlist.

## Use an Agent in chat

After at least one chat-selectable profile exists, an **Agent** picker appears beside the model picker. Select the orchestration profile for the thread, then send normally. The selected revision is pinned to the thread so an edit made later cannot silently change work already in progress.

The selected model receives the profile instructions, matching Rules, hook context, and the T3 Agent tools. It can:

- list allowed profiles;
- start child agents asynchronously;
- inspect status and paginated results;
- wait for progress without polling;
- send a follow-up, cancel a run, or integrate isolated work.

Child work appears as ordinary durable T3 threads. It remains visible from another browser, desktop client, or mobile client connected to the same environment.

## Shared and isolated workspaces

**Shared** agents work in the invoking thread's workspace. Use a low shared-write concurrency when several writers could touch the same files.

**Isolated worktree** agents get a separate Git worktree. When they finish, the parent can review the result and integrate the tracked patch. Integration stops safely when the target is dirty, the repositories differ, the patch conflicts, or the child created untracked files. Resolve those conditions explicitly instead of letting T3 guess.

## Rules

Rules are reusable instruction documents. A Rule can always apply, match workspace-relative file globs, or be attached explicitly to selected profiles. Matching is deterministic by scope, then priority and id.

File-aware matching uses files explicitly attached or mentioned in the task. Always-apply and profile-attached Rules do not require a file mention.

## Provider compatibility

Agents use T3-owned MCP tools and ordinary T3 threads, so orchestration is not tied to Codex, Grok, Claude, Cursor, or OpenCode. Each provider adapter declares what it can enforce. T3 refuses a spawn when a profile asks for a guarantee the selected provider cannot provide, such as exact native tool restriction, required system-level instructions, or unavailable token/cost accounting.

This also keeps future providers honest: a new adapter is unsupported for strict Agent requirements until it declares those capabilities.

## Hooks and safety

Context hooks read a bounded workspace-relative file. Shell hooks run at a named lifecycle stage with a timeout and bounded output. Each hook either blocks the operation on failure or records a warning.

Project documents and hook paths are contained within the project root. Profile saves use revision checks, so two clients cannot silently overwrite one another.

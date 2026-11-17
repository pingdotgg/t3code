---
name: plan-to-issues
description: |
  Convert an approved plan into a GitHub Issues epic with tasks. Detects parallel vs sequential
  phases from plan structure and sets dependencies accordingly. Run after the plan passed the
  replan audit and the user approved it.
disable-model-invocation: true
---

# Plan to GitHub Issues: epic plus tasks

Convert the current approved plan into a GitHub Issues epic with properly structured tasks and
dependencies. This bridges the gap between "we know what to do" and "let's track execution."

## Step 1: find the plan

- If the user gave a file path, read that file completely and use it.
- Otherwise use the most recently approved plan in this conversation.

If neither exists, ask the user for the plan or its path. Do not go looking for plan files
elsewhere.

If the plan has not been through the `replan` audit yet, run that first, so the issues start
from a plan with full coverage. If the audit changed the plan, show the user what changed and get
their approval, as a structured question if your harness offers one, before creating anything.

## Step 2: parse the plan

Extract from the plan:

1. **Title.** First heading or `# Plan:` line
2. **Summary.** Content under `## Summary` or the first paragraph
3. **Phases/Steps.** Each `### Phase N:`, `### N.`, or numbered section
4. **Files affected.** Any file paths mentioned (include in epic description)
5. **Dependency structure.** Determine what depends on what:

### Detecting parallel vs sequential

- **Sequential indicators:** "after", "then", "once X is done", "depends on", numbered order
  with no contrary signals
- **Parallel indicators:** "simultaneously", "independently", "can be done in parallel",
  tasks in different domains (e.g., frontend + backend), tasks touching unrelated files
- **When ambiguous:** Default to sequential, but flag it and ask the user

Build a dependency graph, not just a linear chain.

The issues use the same shape as the `to-tickets` skill, so a maestro daemon and
the Matt Pocock skills read them alike: tasks are native sub-issues of the epic, blocking uses
GitHub's native issue dependencies, and readiness is the `ready-for-agent` triage label. The
`--parent` and `--blocked-by` flags need `gh` 2.94 or later. On an older `gh`, use the REST
calls in the `setup-matt-pocock-skills` GitHub tracker doc.

## Step 3: create the epic

```bash
gh issue create --title "[Plan Title]" --label epic --body "[summary]

Files: [list affected files]"
```

Capture the epic ID from the output. GitHub tracks task completion through its sub-issues, so
the body needs no task list.

## Step 4: create the tasks

Create the tasks in dependency order, blockers first, so every blocking edge can name a real
issue number:

```bash
gh issue create --title "[Phase title]" --label task --label ready-for-agent --parent <epic-id> \
  --blocked-by <other-id>,<other-id> --body "[first paragraph of phase content]"
```

- Leave out `--blocked-by` for a task with no blockers
- Use the first paragraph as the description (keep it scannable)
- Preserve any acceptance criteria or specific requirements in the body
- If a phase has sub-steps, include them as a checklist in the body
- Capture each created issue number from the output

`ready-for-agent` goes on blocked tasks too. It says the task is specified well enough for an
agent. Whether it can start yet comes from its blockers, which GitHub tracks, so no label
changes when a blocker closes.

Tasks a person has to do by hand, such as issuing a real invite or clicking through a vendor's
dashboard, get `ready-for-human` instead of `ready-for-agent`, whether blocked or not. A
maestro daemon never claims or requeues them.

## Step 5: report

If a `maestro <owner/repo>` thread exists (`t3_thread_list` with `titleContains`), send it `dispatch now` with `t3_thread_send`, so a paused maestro picks the new issues up.

Output a clear summary:

```
Created from: [filename or "conversation plan"]

Epic: [title] (#<epic-id>)
  ├── [Phase 1] (#<id>) can start
  ├── [Phase 2] (#<id>) blocked by #<phase1-id>
  ├── [Phase 3] (#<id>) blocked by #<phase1-id>, parallel with Phase 4
  ├── [Phase 4] (#<id>) blocked by #<phase1-id>, parallel with Phase 3
  └── [Phase 5] (#<id>) blocked by #<phase3-id>, #<phase4-id>

Dependency graph:
  Phase 1 → Phase 2
  Phase 1 → Phase 3 ┐
  Phase 1 → Phase 4 ┤→ Phase 5
                     ┘

Total: [N] tasks ([M] can start now, [K] blocked)
Run `gh issue list --label ready-for-agent --state open --search "-is:blocked -label:in-progress"` to see what can start.
```

## Rules

- Preserve the original plan file, if there is one. Never modify or delete it
- Task descriptions use first paragraph only unless there are critical details
- When in doubt about parallel vs sequential, ASK. Wrong dependencies waste time
- If the plan has no clear phases (just a wall of text), break it into logical chunks and
  confirm the breakdown with the user before creating issues

**Related:** It follows `replan`. After it, offer `maestro` for parallel work or `bcheck` for one issue now. Ask before switching skills.

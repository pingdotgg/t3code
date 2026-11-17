---
name: bcheck
description: |
  Pick up a GitHub issue (by ID or next ready), assess if it has enough context to implement,
  and either start working or plan first to gather missing context. Ends with the replan skill if planning.
---

# Bcheck: context assessment and smart start

You are a pragmatic tech lead deciding whether a task is ready to execute or needs more planning.
Your job: pick up an issue, read it deeply, assess the codebase, and decide. Can I start coding
right now, or do I need to ask questions first?

## Step 1: select the issue

If the user gave an issue ID, use it:

```bash
gh issue view <id>
```

If no argument provided, find the next issue on the frontier: open, specified for an agent, no
open blocker, and not claimed:

```bash
gh issue list --label ready-for-agent --state open --search "-is:blocked -label:in-progress -label:needs-help -label:ready-for-human sort:created-asc"
```

Pick the first (oldest, highest priority) issue from the list. Run `gh issue view <id>` on it.

If the frontier is empty, say so and stop.

## Step 2: gather context

Read the issue thoroughly. Extract:

1. **What.** What needs to be built/fixed/changed?
2. **Where.** What files/modules are involved? (May need codebase exploration)
3. **How.** Are there specific implementation details or constraints?
4. **Acceptance.** What does "done" look like?
5. **Dependencies.** What does this issue depend on? Are those done?

Then **explore the codebase** to understand the current state:

- Read the files that will be affected
- Understand the patterns already in use
- Check if related work has been done (look at recent commits, related files)
- Identify any technical constraints the issue description might not mention

## Step 3: context sufficiency assessment

Score each dimension. Be honest. Erring toward "not enough" saves time over starting and getting stuck.

| Dimension                             | Sufficient? | Notes |
| ------------------------------------- | ----------- | ----- |
| **What.** Clear deliverable?          | ✅/❌       |       |
| **Where.** Know which files to touch? | ✅/❌       |       |
| **How.** Know the approach?           | ✅/❌       |       |
| **Acceptance.** Know when it's done?  | ✅/❌       |       |
| **Scope.** Bounded and reasonable?    | ✅/❌       |       |

### Decision criteria

**Ready to implement** (all must be true):

- "What" is clear. You could explain the deliverable in one sentence
- "Where" is known. You've identified the specific files to modify
- "How" is obvious. The approach follows existing patterns or is straightforward
- Scope is small to medium, no more than about 5 files
- No open questions that would change the approach

**Needs planning** (any one triggers planning):

- "What" is vague. Multiple interpretations are possible
- "Where" is unclear. It could live in several places, so the layering is a real decision
- "How" has multiple valid approaches and you need to pick one
- Scope is large: 5+ files, new patterns, or cross-cutting changes
- You have questions whose answers would change what you build
- The issue description is sparse and the codebase exploration raised more questions than it answered

## Step 4A: ready, just start

If context is sufficient:

1. Claim the issue:

```bash
gh issue edit <id> --add-label in-progress
```

2. State your assessment briefly:

```
## Assessment: Ready to implement

**Issue:** [title] ([id])
**Approach:** [1-2 sentence summary of what you'll do]
**Files:** [list of files you'll touch]
```

3. **Start implementing immediately.** No planning round, no ceremony. Just code, then ship it with the `full-send` skill; its merge closes the issue.

## Step 4B: needs planning, plan first

If context is insufficient:

1. Claim the issue:

```bash
gh issue edit <id> --add-label in-progress
```

2. State what you know and what's missing:

```
## Assessment: Needs planning

**Issue:** [title] ([id])
**What I know:** [bullet list of clear parts]
**What's unclear:** [bullet list of gaps/questions]
```

3. Plan before you touch code:
   - Ask the user about each unclear dimension (as a structured question if your harness offers
     one), always leading with your best guess
   - Explore the codebase further as answers come in
   - Build a concrete implementation plan and write it down

4. Before you present the plan, use the `replan` skill to audit coverage.

5. Get the user's approval of the audited plan, then implement it and ship it with the `full-send` skill.

Whichever path you took: after the merge, if the issue's parent `epic` has no open sub-issues left, close it: `gh issue close <epic> --comment "every sub-issue is closed."`

## Rules

- Do NOT default to "needs planning" out of caution. Small, clear tasks should just start.
  A bug fix with a stack trace pointing to a specific line? Just fix it. A new button that
  follows an existing pattern? Just build it.
- Do NOT start coding if you have genuine uncertainty about the approach. Starting wrong wastes
  more time than a 2-minute planning phase.
- Do NOT ask questions you can answer yourself by reading the codebase. Explore first, ask second.
- DO claim the issue (mark in_progress) regardless of which path you take.
- DO be specific about what's unclear. "I need more context" is useless. "I don't know whether
  this should be a new route or a modal on the existing page" is actionable.
- If the issue has a design doc, notes, or linked issues, read those too before deciding.
- The threshold is: "Could a competent developer who knows this codebase start coding right now
  without asking any questions?" If yes, start. If no, plan.

**Related:** One issue, in this session. For several in parallel, offer `maestro`. Ask before switching skills.

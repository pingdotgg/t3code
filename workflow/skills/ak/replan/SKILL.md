---
name: replan
description: |
  Audit coverage against everything the conversation asked for, then rewrite to 100%.
  Audits the current plan by default, or the delivered work when there is no plan left to
  fix. Pass "plan" or "delivered" to force a target. Run it on every plan before you present
  the plan for the user's approval.
---

# Replan: coverage audit plus 100% rewrite

Audit what was requested against what exists, then rewrite so every requirement is fully covered.
Be strict, concrete, and skeptical. No hand-waving.

## Step 0: pick the target

Two things can be audited, and the phases below are identical apart from what you score against.

Run this audit on every plan before you hand it to the user for approval: write the plan, score it
here, fix the gaps, and only then present it.

**Plan mode.** Score the current plan. Use this while a plan is still being written or revised,
which is the common case and the default.

**Delivered mode.** Score what actually shipped. Use this after implementation, when the question
is whether the work matches the ask rather than whether the plan does. Examples: a plan was
approved and executed, a file was written, a feature was built.

Choose like this:

1. If the user passed `plan` or `delivered`, use that. It overrides everything below.
2. If you are still writing a plan, or a plan exists that has not been executed yet, use plan mode.
3. If code, files, or features were produced this session, use delivered mode.
4. If both a plan and delivered work exist, use delivered mode. The plan is no longer the thing
   that can be wrong.

State which mode you picked in one line before Phase 1, so the user can redirect you.

## Phase 1: coverage audit

Read the entire conversation and extract all requirements, explicit and inferred.

Include:

- Features, behaviors, constraints and preferences, edge cases
- Non-functional expectations (UX, performance, reliability, error handling)
- Acceptance criteria the user mentioned

Score each requirement. In plan mode you score it against the plan's steps. In delivered mode you
score it against verifiable outcomes: the diff, the file on disk, the running behavior.

| Status     | Plan mode                             | Delivered mode                               |
| ---------- | ------------------------------------- | -------------------------------------------- |
| ✅ Covered | Explicit, actionable plan steps exist | Verifiable delivered outcome exists          |
| ⚠️ Partial | Mentioned but vague or incomplete     | Delivered but incomplete or weakly evidenced |
| ❌ Missing | Not addressed                         | Not delivered                                |

Output:

```
| # | Requirement | Status | Score (0-10) | Minimal change to reach 10/10 |
|---|-------------|--------|--------------|--------------------------------|
| 1 | ... | ✅/⚠️/❌ | 0-10 | exact step edit/addition needed |
```

Then:

```
## Coverage Report
Mode: plan | delivered
Total Requirements: N
Covered: X (N%)
Partial: Y (N%)
Missing: Z (N%)
Overall Grade: 0-100% + one-line judgment
```

Rule: for every ⚠️ or ❌ row, the `Minimal change to reach 10/10` cell is mandatory and must be
concrete. If a decision is required, end that cell with one precise blocking question.

## Phase 2: rewrite to 100%

Produce an updated plan. In delivered mode this is a delta plan: the smallest set of changes that
closes the gap, not a rewrite of work that already landed.

1. Keep what is already good, whether that is a covered plan step or a delivered outcome
2. Expand partial items into concrete executable steps
3. Add missing steps in the correct order
4. Keep dependencies and sequencing clear
5. Be specific enough to execute without guessing

After the updated plan, if the score was low, rerun the coverage audit on it to confirm 100%.

Hard rules:

- Every requirement appears once in the final checklist
- The final checklist must be 100% ✅ 10/10
- If 100% is impossible without input, ask one precise blocking question
- No scope creep. Do not add requirements that were not requested
- No vague language. Avoid "maybe", "consider", "etc"
- Change as little as possible. Minimal edit to the plan in plan mode, minimal edit to the
  delivered work in delivered mode
- Ask when in doubt
- Run at most 3 audit-and-rewrite rounds. If gaps remain after the third, stop and show the user what is still uncovered

## Next step

In plan mode, once the user approves the audited plan, suggest the `plan-to-issues` skill to turn
it into a GitHub issue epic with tasks. In delivered mode there is no plan to convert, so once the
delta is applied, suggest the `verify` skill instead.

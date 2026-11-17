---
name: triage
description: |
  Walk through code review findings (from the linus skill or similar) point by point. For each item,
  present the finding, give a recommendation with alternatives, discuss, and decide on action.
  Generates a summary of decisions and executes agreed fixes.
---

# Triage: review findings walkthrough

You are a collaborative triage partner. Your job is to walk through code review findings
systematically, ensuring nothing falls through the cracks while keeping the conversation
efficient.

## Phase 1: gather findings

Look at the conversation history for the most recent code review output (from the `linus` skill
or a similar review). Extract every finding into a structured list:

For each finding, capture:

- **ID.** Sequential number (F1, F2, F3...)
- **Severity.** 🔴 Critical / ⚠️ Important / 💡 Minor (preserve from review)
- **Category.** Bug, Security, Performance, Style, Architecture, Testing, etc.
- **Summary.** One-line description
- **File(s).** What files are affected

## Phase 2: overview table

Present ALL findings as a table so the user sees the full picture:

```
## Review Findings: [N] items

| # | Sev | Category | Summary | File(s) |
|---|-----|----------|---------|---------|
| F1 | 🔴 | Security | SQL injection in user query | src/db/users.ts:45 |
| F2 | ⚠️ | Perf | N+1 query in list endpoint | src/api/list.ts:82 |
| F3 | 💡 | Style | Inconsistent naming | src/utils.ts:12 |
...

🔴 Critical: X | ⚠️ Important: Y | 💡 Minor: Z
```

Then say: "Let's walk through these one at a time, starting with criticals. Ready?"

## Phase 3: batched discussion

Process findings in **batches of up to 4**, grouped by severity (criticals first). For each batch:

### Present the batch

For each finding in the batch, output a short block:

```
### F[N]: [Summary]
**Severity:** [icon] [level] | **Category:** [category] | **Location:** [file:line]

**Problem:** [Brief explanation, quoting the original review]
**Why it matters:** [Concrete consequences]

**Recommendation:** [Your suggested approach]
**Alternatives:** (a) [Alt A, tradeoff] (b) [Alt B, tradeoff] (c) [Skip, what you'd lose]
```

Always lead with what YOU think is best. Listing options without an opinion is lazy.

### Ask all at once

Ask the user about the whole batch in one go, one question per finding (as a structured
question if your harness offers one). Each question should:

- Lead with the finding ID (e.g., "F1", "F2")
- Have contextual options for THAT finding (the recommended fix, a specific alternative,
  "Defer to GitHub issue", "Disagree/skip")
- NOT be generic accept/reject. Tailor options to the specific finding

Example questions for a batch of 3:

```
F1: SQL injection in user query, how to handle?   [options...]
F2: N+1 query in list endpoint, how to handle?    [options...]
F3: Inconsistent naming, how to handle?           [options...]
```

### Record decisions

After the user responds, record each decision internally:

```
F[N]: [ACCEPT | DEFER | DISAGREE | ALTERNATIVE], [brief note on what was decided]
```

- **Accept.** Will fix now as discussed
- **Defer.** Create a GitHub issue for later (`gh issue create`)
- **Disagree.** Skip with documented reason
- **Alternative.** Fix differently than originally recommended

Then move to the next batch. Don't linger.

## Phase 4: summary and execution plan

After all items are discussed, present the final tally:

```
## Triage Complete

| Decision | Count | Items |
|----------|-------|-------|
| Accept (fix now) | X | F1, F3, F7 |
| Defer (GitHub issue) | Y | F4, F9 |
| Disagree (skip) | Z | F2, F5 |
| Alternative fix | W | F6, F8 |

### Fix Now ([X] items):
1. F1: [what will be done]
2. F3: [what will be done]
3. F7: [what will be done]

### Deferred ([Y] items):
- F4: [will create GitHub issue: "..."]
- F9: [will create GitHub issue: "..."]
```

Then ask: "Should I proceed with the fixes and create the deferred tasks?"

## Phase 5: execute

1. **Fix accepted items.** Apply the agreed fixes directly. If any fix turns out to be
   more complex than expected, stop and flag it (might need replanning)
2. **Create deferred issues.** `gh issue create` for each deferred item with proper title, body, and labels
3. **Report.** Brief summary of what was done

Once the fixes are applied, suggest the `verify` skill to test the changes and the areas around
them in the browser.

## Rules

- Present the OVERVIEW FIRST. Don't dive into item 1 without showing the full list
- Batch up to 4 findings per round of questions. This keeps momentum
- Always have a recommendation. "What do you think?" without a suggestion is lazy
- Alternatives should be REAL alternatives, not strawmen to make your pick look good
- If a fix turns out to require significant changes (touching 5+ files, architectural),
  flag it. That's a new planning cycle, not a triage fix
- Don't re-review code that wasn't flagged. Triage is about the findings, not adding more
- Keep momentum. Most items should take 30 seconds of discussion, not 5 minutes

**Related:** It works on findings from `linus`, `diff-review` or `interrogate`. With none yet, offer `linus` first. Not for GitHub issues: that is `triage-issues`. Ask before switching skills.

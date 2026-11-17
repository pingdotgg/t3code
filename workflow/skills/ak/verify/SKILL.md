---
name: verify
description: |
  Browser-based verification of implemented changes and related functionality. Generates a
  test checklist from what changed, gets user approval, then systematically tests each item
  in a browser (in T3 Code: the preview tools). Run after implementation is complete.
---

# Verify: browser-based testing

Systematically verify that implemented changes work correctly AND haven't broken related
functionality. Use a browser to test everything visually. In T3 Code that is the preview tools:
`preview_open`, `preview_navigate`, `preview_snapshot`, `preview_act`, `preview_wait_for` and
`preview_evaluate`. Outside T3 Code, use whatever browser tools your harness offers.

## Phase 1: build the checklist

Analyze what was implemented by examining:

1. **Git diff.** `git diff` and `git log` to see what files changed
2. **Conversation history.** What features/fixes were implemented
3. **GitHub issues.** If tracking with gh issues, check what was closed this session via `gh issue list --search 'closed:>=<date>'`

From this, build two categories of test items:

### Direct changes (must pass)

Things that were explicitly changed or added:

- New UI elements visible and functional
- Modified behavior working as expected
- Fixed bugs no longer reproducing
- API endpoints returning correct data

### Related areas (regression check)

Functionality connected to what changed:

- Adjacent UI components still rendering correctly
- Navigation flows that touch modified pages
- Data that feeds into or out of modified components
- Edge cases: empty states, error states, loading states

### Checklist format

```
## Verification Checklist

### Direct Changes
- [ ] DC1: [Description]. Test by [how]
- [ ] DC2: [Description]. Test by [how]
- [ ] DC3: [Description]. Test by [how]

### Related Areas
- [ ] RA1: [Description]. Check [what]
- [ ] RA2: [Description]. Check [what]

Total: [N] items ([X] direct, [Y] related)
```

## Phase 2: user approval

Present the checklist, then ask (as structured questions if your harness offers them):

- "Anything missing from this list?"
- "Any items you want to skip?"
- "What URL should I start at?"

Adjust the checklist based on feedback before proceeding.

## Phase 3: execute tests

If the repo has a verification skill (`verify-*`, `test-*`), follow its Launch, Doctor and Drive sections and take Related areas from its feature map. If the app has none and no documented launch, offer `create-verification-skill` once. If the run shows the map is wrong, offer `maintain-verification-skill`.

Open one tab for the run (`preview_open`, with the dev server's port as its target) and keep
using its `tabId`. Then for each checklist item:

1. **Navigate** to the relevant page (`preview_navigate`)
2. **Take a snapshot** to understand the current state (`preview_snapshot`)
3. **Interact.** click, type, select, scroll as needed to test the item (`preview_act`, targeting
   elements by the `aria-ref` from the latest snapshot; `preview_wait_for` for async changes)
4. **Take a screenshot** if something looks wrong or noteworthy (`preview_snapshot` with
   `save=true`)
5. **Record result:**

```
### DC1: [Description]
**Status:** ✅ Pass / ❌ Fail / ⚠️ Partial
**What I did:** [actions taken]
**Result:** [what happened]
**Screenshot:** [if relevant]
```

### Testing strategy

- **Don't rush.** Take snapshots before and after actions
- **Check visual state.** elements visible, correct text, proper styling
- **Check interactions.** buttons work, forms submit, navigation flows
- **Check data.** correct values displayed, updates persist
- **Check edge cases.** empty lists, long text, missing data
- **Check console.** note any errors or warnings (the diagnostics in `preview_snapshot`)

## Phase 4: results report

After all items tested:

```
## Verification Results

| # | Item | Status | Notes |
|---|------|--------|-------|
| DC1 | ... | ✅ | Works as expected |
| DC2 | ... | ❌ | Button doesn't respond to click |
| RA1 | ... | ⚠️ | Works but layout shifted slightly |

### Summary
✅ Passed: X/N
❌ Failed: Y/N
⚠️ Partial: Z/N

### Failures (need fixing):
1. DC2: [what's wrong and likely cause]

### Warnings (may need attention):
1. RA1: [what's off and whether it matters]
```

## Phase 5: handle failures

For any ❌ or ⚠️ items:

- Describe what went wrong clearly
- Suggest the likely cause (based on what you saw + the code changes)
- Ask if the user wants to fix now or defer

If fixing now, apply fixes and re-test those specific items.

## Rules

- ALWAYS build and present the checklist BEFORE testing. No ad-hoc wandering
- Test BOTH direct changes and related areas. Skipping regression checks defeats the purpose
- Take snapshots liberally. Visual state is the primary evidence
- If the dev server isn't running, check and start it from your own shell before testing
- Close the tab you opened once the run is done, unless the user wants to keep it
- Don't test implementation details (internal state, console logs) unless relevant to a bug
- If a page requires auth or specific state, ask the user how to set that up
- Report failures factually. Don't apologize or hedge. State what's broken

**Related:** `validate-change` checks the code; this checks the running app. Run it after that. Ask before switching skills.

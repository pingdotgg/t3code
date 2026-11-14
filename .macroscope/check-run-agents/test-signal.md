---
title: Test Signal
model: gpt-6-1-terra
reasoning: low
input: incremental
tools:
  - browse_code
  - modify_pr
# An explicit include overrides ignore.md, which skips test files for every other check.
include:
  - "**/*.test.*"
exclude:
  - ".repos/**"
requires:
  - Check
maxBudgetPerRun: 1
maxBudgetPerPR: 5
conclusion: neutral
---

# Test signal review

Review only the tests this pull request adds or grows. Tests it moves, renames, or deletes are not findings. The rules are in `docs/internals/testing.md` under `## What to test`; read that section first and hold new tests to it.

Post each finding as a brief inline comment on the new test with one fix. Ask only for fewer or smaller tests, never for more coverage.

When there are no findings, make the entire final response exactly `All clear` on one line with nothing else.

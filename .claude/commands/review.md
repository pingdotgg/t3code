---
description: Run a PR-style review focused on bugs, regressions, and validation gaps.
---

Perform a review of the current branch as if preparing for PR.

Use a blame-free, lightweight conversation style. Treat the review as a risk-and-action exercise, not a compliance theater audit.

If `docs/project.md` is still in template state, call that out as a setup gap before performing detailed review.

Checklist:

1. Identify behavioral regressions and high-risk changes first.
2. Check that relevant Markdown docs reflect the implementation, or that the PR explicitly marks no documentation impact.
3. Call out missing or weak tests, or missing no-test-impact justification.
4. Check for PDPL compliance: no real PII in tests, logs, or code.
5. Check for AR/EN string coverage if any user-facing text changed.
6. Check AWS Well-Architected impact: operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability.
7. Run `bun check` and include failures/warnings in the report.
8. If a PR exists, verify GitHub checks are green (`bun pr:check` or `gh pr checks`).
9. Verify OpenAPI drift: if API changed, confirm `bun contracts:check` was run (Stack A).
10. Provide a concise severity-ordered findings list with file references.
11. Include open questions and assumptions that need confirmation.

Prioritize correctness and release risk over style nits.

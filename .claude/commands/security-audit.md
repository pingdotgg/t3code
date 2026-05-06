---
description: Run a local deep security audit with Claude Code over a bounded target.
argument-hint: [target-directory] [--max-files <n>] [--dry-run]
---

Run the local-only security audit.

Use `$ARGUMENTS` as script arguments.

Rules:

1. Do not run this through the raw Anthropic API. The audit intentionally uses
   Claude Code CLI local context because raw API security probes may be
   rate-limited or blocked.
2. Keep the target narrow, for example `convex/` or `apps/api/src/`.
3. Reports must land under `.local/security-audit/`, never project root.
4. Do not commit audit output.

Run:

```bash
bash scripts/security-audit.sh $ARGUMENTS
```

Review `.local/security-audit/<timestamp>/SUMMARY.md` when complete.

---
name: principle-prove-it-works
description: "Apply after completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or 'it compiles.'"
disable-model-invocation: true
---

# Prove It Works

Verify every task output by checking the real thing directly. Do not infer from proxies, self-reports, or "it compiles."

**Why:** Unverified work has unknown correctness. Indirect verification (file mtimes, output freshness, agent self-reports, cached screenshots) feels cheaper than direct observation. Acting on a wrong inference costs far more than checking the source.

Check the real thing, not a proxy:

- Check process liveness directly, not indirectly through derived state
- Read the actual value, not a cached or derived representation
- When verification fails, suspect the observation method before suspecting the system

## Script the check when you can

The strongest proof is a deterministic script, test or lint that re-runs the same comparison, not a one-time eyeball. Write it, run it, and show its output so a reviewer can re-run it instead of trusting your word. When the check guards lasting behavior, land it as a test or lint in the repo's own check targets; otherwise keep it out of the repo.

Show the evidence in your reply or PR. Do not write docs, ADRs or agent READMEs to explain it, and do not commit generated artifacts, logs or screenshots unless the user asks.

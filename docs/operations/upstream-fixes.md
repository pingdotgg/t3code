# Reviewing upstream fixes

The upstream workflow proposes at most 12 fixes from the next 120 commits it can scan. It runs on a six-hour schedule or on demand. It leaves an open batch and its history alone, even when CI fails. The workflow starts CI but never merges the PR or queues another run.

Review the PR and wait for CI. Merge the whole batch only if the included fixes and the cursor update are ready. If a batch needs to be broken apart, record any deliberately skipped commits in `.github/upstream-fixes/skip` on `main`, close the batch, and run the workflow with a smaller `max`. The cursor only advances when a reviewed batch reaches `main`. Copy any unresolved conflicts or held picks out of a batch before merging it so they do not disappear behind the cursor.

GitHub can delay scheduled runs. A manually dispatched run uses the same safeguards and is enough to prepare a batch when the schedule is late.

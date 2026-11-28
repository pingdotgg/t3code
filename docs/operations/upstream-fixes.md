# Reviewing upstream fixes

The upstream workflow proposes at most 12 fixes from the next 120 commits it can scan. It runs every six hours at 00:37, 06:37, 12:37 and 18:37 UTC, with a backup attempt one hour after each scheduled run. GitHub schedules are best effort and can be delayed or dropped; neither schedule guarantees an exact start time. A manual dispatch uses the same safeguards.

An open batch blocks new picks. Each run links that PR and lists its checks in the run summary, leaving its branch and history alone even when CI fails. The workflow starts CI but never merges the PR. Merging a batch from this repository's `upstream-fixes` branch immediately triggers the next batch, so the backlog can progress without waiting for the next scheduled attempt.

Review the PR and wait for CI. Merge the whole batch only if the included fixes and the cursor update are ready. If a batch needs to be broken apart, record any deliberately skipped commits in `.github/upstream-fixes/skip` on `main`, close the batch, and run the workflow with a smaller `max`. The cursor only advances when a reviewed batch reaches `main`. Copy any unresolved conflicts or held picks out of a batch before merging it so they do not disappear behind the cursor.

Branding, telemetry no-ops, and dedicated local vault, PIN and private-read code are protected from automatic picks. Changes to those areas need a manual port that preserves the fork's behavior. Running the picker locally requires a clean worktree and a cursor within the fetched upstream history. A Git tooling failure stops the run without advancing its cursor; ordinary cherry-pick conflicts are reported for review.

GitHub's upstream comparison counts ancestry, so cherry-picked fixes still appear as commits behind upstream. Use the reviewed cursor and batch summaries to judge progress rather than merging upstream wholesale to reduce that number.

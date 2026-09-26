# After an audit

Read this only when the user asks for fixes, a fresh post-fix audit, publishing,
or ongoing PR babysitting. Keep the authorization separate for each action.
Permission to fix code is not permission to push, post a review, or merge.
Reuse authorization already given, including the publication steps inherent in
an explicit request to create or update a PR. Ask only at a new boundary.

For authorized PR creation, updating, or babysitting, use
[prepare-pr](../../prepare-pr/SKILL.md) as the lifecycle owner. Carry this
audit's reviewed revisions, findings and remaining checks into that workflow;
apply the review and monitoring rules below without starting a second lifecycle.
Local-fix-only requests stay local. Description-only and media-only requests
keep their narrower scope; neither starts a code audit unless requested.

## Fixing and publishing

Work on the same PR unless the user asks to split or replace it. Verify the PR's
head repository and branch before publishing; do not leave fixes on a new branch
that the PR does not contain. For stacked PRs, respect their actual bases and use
the repository's existing stack workflow rather than flattening dependencies.

Make the smallest fixes that address the accepted findings. Remove unjustified
complexity instead of adding another layer around it. Tests should exercise the
bug or invariant; use the test framework's parameterized form, such as `it.each`,
when several cases share the same setup. Avoid unrelated tests and cleanup.

Verify the changed behavior with focused tests and relevant lint or type checks.
If authorized UI verification matters, show the affected state before and after.
Use the actual base and head with comparable fixtures, not a hand-reconstructed
"before". Inspect the captures and make sure the changed state is visible.
Keep PR-only captures out of source control and follow the repository's upload
convention when publishing. Preserve author credit when reusing another PR's work.
Honor the current instructions for public model attribution.

After the fixes, personally re-read the whole PR against its base. Confirm the
old findings are gone and look for newly introduced failures. Passing tests and
bot approval do not replace this review. Record the head you actually reviewed.
Use the audit skill's finding format for any remaining issues. Pass the result
back to `prepare-pr` so the published description, verification claims, and
media match that revision. Complete its publication/readback checks before
reporting an authorized PR update finished. Review readiness, merge readiness,
and permission to merge remain separate.

## Babysitting

Track the latest pushed SHA, new CI results, and review activity since that push.
Recheck unresolved older findings for continued relevance, but do not repeatedly
act on stale comments or accept an older green run as approval of a newer head.

Validate bot findings in the source. Fix real ones within the authorized scope.
If authorized to reply or resolve threads, explain why a false positive is wrong
or which verified fix addresses it. Do not silently resolve a genuine open issue.
Use only the review services already configured unless the user requests another.

Use the host's monitoring mechanism for sustained waiting. Stay quiet when
nothing changes. If monitoring is unavailable, report the current state and the
remaining gate; do not claim you will keep watching after the turn ends.

Stop when the latest head satisfies the requested checks and has no unresolved
actionable review findings. Then report readiness. If the user also authorized
merging, refresh the head and merge gates once more, audit any new commits, and
merge only that verified revision. Report an access failure or a required human
decision instead of retrying mutations indefinitely.

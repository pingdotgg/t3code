# Contributing

## Developer setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites.

## Read this first

We are not actively seeking outside contributions and have limited review capacity. Opening a PR does
not create an obligation to review or merge it. We may close or defer it, ask for a smaller scope, or
reimplement the idea later. Meeting this guide's requirements makes a PR eligible for deeper review;
it does not guarantee acceptance.

These requirements apply to every open PR, including drafts. Draft status does not postpone triage
or excuse missing approval, unfocused scope, or inadequate verification. A draft can be closed for
the same reasons as a ready PR; converting a PR to draft does not exempt it from reassessment.

Focused bug fixes, reliability fixes, performance improvements, and maintenance work are the most
likely to be accepted. Unsolicited features, opinionated rewrites, and unrelated cleanup are not.

Report bugs in issues. Feature requests and proposals belong in
[Ideas discussions](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
Search existing reports, discussions, and documented workflows before starting work.

<a id="prior-approval"></a>

## Establish the problem and scope first

Outside the focused exceptions below, features and intentional changes to product behavior require
a prior discussion with explicit maintainer approval of the direction and scope. Link the approval
itself in your PR. A linked issue or discussion alone is insufficient. Calling a behavior change a bug
fix does not exempt it from this requirement. Acceptance of a problem does not approve every
implementation or promise a merge.

For a substantial bug fix, link an issue that maintainers have triaged to establish the actual failure
and intended behavior. For other non-trivial work outside the exceptions below, agree on direction
and scope with maintainers in an Ideas discussion before implementing it.

A very small, focused fix for an obvious bug can be submitted without a prior issue or discussion.
Explain the defect and why the fix qualifies for this exception. We judge purpose, behavioral impact,
and the changes needed to fix it. There is no line-count or file-count cutoff. A shared-contract fix may
need changes across several clients; a few lines changing product defaults may require a discussion.

A focused configuration option for an established capability may also be eligible without prior
feature approval. Explain the existing capability, what the option controls, and why its scope stays
within that capability. Adding a setting does not by itself make a PR a new feature, and this route
does not depend on proving an obvious bug. Judge its purpose and effects: new workflows, changed
product defaults, and broader behavior choices still require approval, even when exposed as settings.
The one-problem and verification requirements still apply; deeper review may reject the proposed
configuration mechanism on design or correctness grounds.

Choosing an executable path for an already-supported hosting CLI can fit this configuration route.
Keeping Files open as a separate tab alongside file previews changes tab lifetime and navigation,
so it needs prior product-direction approval. Good verification does not replace that approval.

If an existing workflow already solves the reported need, difficulty finding or understanding it can
still be a useful documentation, onboarding, or discoverability problem. Describe that problem.
Maintainers decide the response; it does not automatically justify the proposed feature or behavior change.

<a id="one-problem"></a>

## Solve one underlying problem per PR

A PR that solves multiple independent problems must be split, even when each fix is useful. Count the
underlying problems, not the linked issues. Several reports may describe the same defect.

Include the contract, server, client, test, and documentation changes needed for that one problem.
Explain their relationship when it is not obvious. An adjacent cleanup, refactor, or second fix needs
its own PR unless it is necessary to solve the same problem. A large diff alone does not establish that
the PR contains unrelated work.

This rule is for outside contributions. Maintainers, the logins in
[.github/TRIAGE_EXEMPTIONS.td](.github/TRIAGE_EXEMPTIONS.td), may batch related fixes in one PR.

Follow the [documentation rules](AGENTS.md#documentation). Keep internal docs for decisions and
hard-to-discover constraints. Update user guides when how to use a feature changes; skip descriptions
of obvious controls and cosmetic changes.

<a id="verification"></a>

## Provide evidence for the changed behavior

Explain how you established the problem, how you checked the change, and what you observed. Give the
relevant reproduction steps, environment, focused test commands or manual checks, and their results.
State what you could not check. A checkbox or "tests pass" alone does not show that the change works.

Match the evidence to the change. Use focused tests for behavior that can be tested and manual evidence
where appropriate. Do not substitute broad test runs for checking the affected behavior, or run
repo-wide checks just to satisfy this guide. A backend fix does not need unrelated UI evidence.

UI changes require clear before/after screenshots. Include a short recording when motion, timing,
transitions, or interaction details are needed to demonstrate the changed behavior. Attach or link
evidence in the PR; do not commit PR-only screenshots or recordings to the repository.

Missing or demonstrably inadequate evidence can cause closure. A reviewer being unable to reproduce a
well-documented platform-specific bug does not by itself invalidate the report. We assess the problem,
scope, approval, and evidence, not an author's writing style or whether we think an agent wrote the PR.

<a id="triage-and-review"></a>

## Triage and deeper review

Contribution triage checks whether the problem is established, any required approval is present, the
scope is coherent, and the evidence is adequate. It inspects enough code to support that decision.
Passing triage does not approve correctness, security, performance, or merging. Those need deeper review.
Updates to the PR can change its eligibility and require reassessment.

PRs receive `vouch:*` contributor-status labels and `size:*` diff-size labels. These are context, not
eligibility rules. Vouching through [.github/VOUCHED.td](.github/VOUCHED.td) is separate from permission
to bypass triage. Only the GitHub logins explicitly listed in
[.github/TRIAGE_EXEMPTIONS.td](.github/TRIAGE_EXEMPTIONS.td) bypass triage. Organization membership,
vouching, collaborator or bot status, repository write access, and previous successful PRs do not
establish an exemption. Other contributors, including vouched contributors, go through triage.
Passing once does not grant permanent trust.

Every live run freshly resolves `pingdotgg/t3code`'s `refs/heads/main` to a commit SHA and loads the
contribution-triage skill, this guide, its policy dependencies (including `AGENTS.md` documentation
rules), and the exemption list from that same SHA. PR/fork copies and PR-body instructions cannot
change policy or exemptions. Missing, incomplete, or malformed trusted files leave routing unresolved;
they do not grant an exemption, establish an empty list, or permit automatic closure or review handoff.

The intended review handoff is to request Macroscope review after a PR passes triage, or immediately
for a verified exemption. The review-trigger label and Macroscope configuration still need to be
verified for automation; no private organization-membership lookup is required. The initial rollout
may use partial native GitHub event coverage as described in the contribution-triage skill. Each
supported event fetches current full PR state and assesses cumulative changes; unsupported events are
not wired and there is no periodic sweep. This guide does not announce a deployed automation or change
existing review settings. Neither triage nor a Macroscope review authorizes merging.

<a id="closure-and-reconsideration"></a>

## Closure and reconsideration

Automated triage leaves a PR open for maintainer decision if someone in the trusted
[TRIAGE_EXEMPTIONS.td](.github/TRIAGE_EXEMPTIONS.td) list has commented or submitted a review,
including on an earlier head, or if `triage:keep-open` is present. This protection does not imply
eligibility or review approval.

PRs that violate these requirements can be closed before deeper review. Multiple independent fixes
require splitting. Missing approval requires maintainer discussion or issue triage, as applicable.
Missing evidence requires establishing the problem and showing how the change was checked.

Every policy-based closure must identify the specific rule, cite the evidence supporting the finding,
link the relevant section of this guide, and explain how to address it for reconsideration. For example,
identify the independent fixes to split or the exact missing verification. Correct the deficiency and
request reconsideration, or submit the focused replacement PRs linked to the original.

An unclear relationship between changes needs investigation and, if still unexplained, a specific
request for an explanation. Uncertainty alone is not proof of unrelated work. Access failures,
incomplete retrieval, or an unfinished assessment are reasons to retry the assessment, not close a PR.
If the proposed solution is declined but the report reveals a useful problem, preserve that problem
for maintainer consideration. Feedback should be firm, specific, and free of insults or accusations
about how the contribution was written.

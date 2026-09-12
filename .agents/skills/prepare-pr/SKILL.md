---
name: prepare-pr
description: Complete or maintain T3 Code pull requests, including draft PRs, focused verification, required visual evidence, publication, readback, and review follow-up. Description-only and media-only requests stay scoped.
---

# Create and maintain a pull request

Deliver the requested PR with a verified branch, a clear description, and
checkable evidence for a reviewer who has not seen the conversation. Creating
a PR includes committing and pushing the scoped changes, publishing the PR,
and reading back the result when those actions are authorized.

For a **media-only request**, go directly to
[media-workflow.md](references/media-workflow.md). Produce the requested
artifact and disclose its limits; do not add PR work to that task.

For a **PR request**, follow the steps below. If only the description was
requested, inspect existing facts and evidence, repair the prose, and identify
missing verification rather than silently starting builds or client sessions.
If the target diff or revisions are unavailable, deliver a draft based on the
supplied facts and name the missing inputs; leave its readiness unverified.
When preparing the full PR, complete authorized focused verification and media
work before reporting readiness. Use existing task authorization and current
repository instructions for client automation and publication. Inventory that
authorization once and continue without reconfirming actions the user already
authorized. A published draft is an intermediate checkpoint when the user asked
to complete the PR, not a handoff. If a repository rule requires separate client
automation permission and the user has not granted it, finish available work,
then ask once at that concrete boundary; do not replace the question with a
premature draft handoff.

## 1. Establish the branch, change, and claims

Read current repository instructions, contribution guidance, and the PR
template at the actual target. Resolve the base, candidate revision, diff,
linked issue, and existing description. Record relevant uncommitted overlays
so a capture is not attributed to a clean revision that did not produce it.
Current maintainer direction outranks examples from previously merged PRs.

Inspect Git status, remotes, and the existing PR before choosing a branch.
Resolve the destination repository, base branch, and head owner explicitly;
a fork's `origin/main` may not be upstream main. Fetch the intended upstream
base and record its revision. For an existing PR, continue its head branch;
for a new PR, use a dedicated feature branch. Keep unrelated local changes
intact, using an isolated worktree when needed. Compare the complete contribution
against the fetched base, confirm it is still needed, and resolve merge conflicts
within the task's scope before verification. Preserve a user-requested stacked
base rather than silently retargeting it.

State the concrete trigger, previous behavior, cause when established, and
resulting behavior. For a feature, describe the previous workflow and why the
new one helps. Distinguish an observed cause from a hypothesis. Link the issue
when it supports the claim; close it only when the verified fix covers it and
closure is authorized. Keep one independently reviewable concern. If a combined
change was explicitly requested, explain that reason and map its claims to proof.

Identify affected entry points, clients, providers, contracts, and connection
modes. Use this to select proof, not to print an exhaustive unaffected-surface
checklist. Note a boundary in the description when it changes the reviewer's
interpretation or leaves an important path unverified.

**Complete when:** every material claim is tied to the inspected diff, its
affected behavior, and an identified repository, base, and candidate, or is explicitly
unbound in a description-only draft because the required input is missing.

## 2. Prove the behavior being claimed

For a bug fix, reproduce the actual failure on the base and repeat the same
action on the candidate. Preserve the failing observation or regression test
alongside the passing result. If the baseline cannot be run, state why and
what evidence substitutes for it; do not stage a failure or imply reproduction.
A feature's baseline demonstrates the old workflow, not an invented defect.

Choose the checks that reach the relevant behavior boundary:

| Claim                                       | Needed observation                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save or persistence                         | Confirm the authoritative saved value and reopen/reload when persistence is claimed. A success-looking screen alone is insufficient.                 |
| Navigation, selection, or reversible action | Exercise the relevant return, repeat, undo, reset, or retained selection; check state that the action should preserve.                               |
| Retry or recovery                           | Reproduce the failure, restore the condition, and observe recovery without lost state or duplicate effects.                                          |
| Timing, animation, or performance           | Measure the claimed quantity under stated conditions. Preserve real timing when timing is the evidence.                                              |
| Backend behavior                            | Assert the actual command, storage, protocol, or receipt boundary with focused tests. Add media only when it demonstrates a relevant visible result. |

Apply rows only when the change makes that claim. Keep a compact working map
of each material claim, its base/candidate observation, supporting test or
artifact, and any limitation. This can be working notes; no new receipt schema
or committed audit document is required.

Report exact focused commands and actual outcomes, including meaningful test
counts. Attribute supplied reports to their source and distinguish them from
checks you ran; record missing commands or receipts as gaps. Separate tests
from integrated checks. Name failed, skipped, and unavailable checks honestly. A later successful retry does not erase an
observed flake. Obtain independent review when the repository requires it;
report the actual reviewer and any availability gap without implying approval.

**Complete when:** every material claim has a recorded observation and check
result, or a named verification gap. Carry each gap forward to the description;
a gap in required proof prevents a readiness claim.

## 3. Capture comparable, readable evidence

For user-visible changes, capture actual base/candidate states and identify
the source revisions or build artifacts. Keep the scenario comparable: data,
environment, viewport/device, theme, scroll position, selections, and relevant
loading or failure state. State the conditions that matter next to the media.
Explain deliberate differences, such as a feature changing the default view.

For changes with a visible before/after difference, the minimum evidence is embedded animated GIFs
showing **Before (base)** and **After (candidate)**. Use two vertically stacked,
labeled GIFs or one GIF that shows the labeled base and candidate sequentially.
Candidate-only interaction footage does not satisfy this comparison. For a
static change, a labeled alternating-state GIF made from actual base/candidate
captures is acceptable; disclose that it is a still-state comparison. Preserve
screenshots and source recordings as supporting evidence.

When the changed behavior is not visible, omit animated GIFs. Accessible names,
ARIA relationships, and other nonvisual semantics need actual before/after
accessibility-tree or DOM observations and focused checks. Unchanged screenshots
with different added captions, or footage of an unchanged interaction, do not
make a nonvisual fix visible. Static screenshots may provide control context;
clearly distinguish that context from proof of the changed behavior.

Every visible motion or interaction needed to demonstrate the change must appear in an
animated GIF derived from the actual recording, including the action and settled
result. A still-state slideshow cannot prove motion. MP4 links supplement these
GIFs; they do not replace them. Missing base evidence or a required GIF is an
explicit readiness gap, not permission to invent a baseline or omit the GIF.

Use [media-workflow.md](references/media-workflow.md) for capture, contextual
PNG/GIF cropping, annotation guidance, and inspection. Screenshots show
states; recordings show transitions. Sampled-frame GIFs illustrate selected
states and must be labeled as sampled; they do not establish smoothness or
precise timing. Record durations and any speed changes when relevant.

Before fresh evidence capture, follow [reliable capture setup](references/capture-recovery.md):
choose a recorder with a concrete save path, capture and inspect a short smoke
artifact, then reuse that proven route for the base/candidate flows. Verify each
saved export immediately and keep a receipt for resuming. Use recovery only when
that path fails; continue authorized capture and publication.

For animation or motion changes, capture the complete candidate transition in
a real-time recording. When the claimed improvement is comparative, record the
same flow on the base revision too. Stills and sampled-frame GIFs can clarify
states, but they do not replace the recording that proves the motion.

Capture the follow-through selected in step 2. Record synthetic/disposable
data, mocked endpoints, injected states, simulated media preferences, or
manually composed illustrations as evidence conditions.

**Complete when:** each visual claim has an inspected, legible artifact showing
the relevant action and result under comparable conditions, or a recorded gap.
Skip this step when there is no visual claim and repository rules require no media.

## 4. Write the description around the evidence

Follow the current PR template. Lead with the user's problem and resulting
behavior, then explain the cause and approach only as far as they help review.
Describe the complete contribution: what is being added or changed, who uses
it, and the resulting behavior. Put supporting tools and implementation details
after that explanation. For an existing PR, apply the update loop in step 7.
Remove abandoned approaches, conversation history, repeated summaries, and
empty template sections where the repository permits. A small fix usually
needs a short explanation and focused verification, not a report.

For every material visual claim, place a labeled artifact beside a sentence
describing the observable result. Use descriptive alt text and recording link
labels: “Before: saved purple reopens as green” tells the reviewer what to
inspect; “before.png” does not. Stack labeled evidence vertically at full width.
Side-by-side evidence is prohibited: no Markdown or HTML comparison tables,
columns, or composite images placing states beside one another.
For several states, name each scenario. Put supplementary captures in a
collapsible block when that keeps the main argument easier to read.

Summarize verification with measured results and relevant limits. State the
platform/client actually exercised. Keep limits beside the affected claim:
sampled GIFs, missing recordings, older captures, synthetic input, untested
clients, or incomplete baseline reproduction. A receipt hidden in local storage
does not disclose those limits to a reviewer.

For performance claims, give before/after values, units, measured boundary,
sample count per revision, method, and relevant conditions. Clarify whether a
reported count is total or per revision. Fewer requests do not prove a
faster page; collector timings do not prove app responsiveness. If measurements
do not support the proposed claim, narrow the claim or investigate further.

When the template leaves an evidence-presentation choice unresolved, consult
[pr-examples.md](references/pr-examples.md). Its examples illustrate useful
decisions, not mandatory section names or evidence of current maintainer approval. Include model/harness attribution
only as required by the repository, naming participants who actually ran.

**Complete when:** the title and body explain the final change, attach the
supporting observations to their claims, and disclose every material gap from
steps 2 and 3. Use only sections that carry review-relevant information.

## 5. Commit, push, and create or update the PR

For a full PR request, carry the prepared change through publication using
existing task authorization. A request to create a PR authorizes that workflow;
description-only and media-only requests authorize only their requested text
or media operations, including publication when requested. If publication is
not requested or authorized, deliver the prepared artifacts and exact remaining
step. Creating or updating a PR does not authorize merging it.

1. Inspect the staged diff and stage only the intended contribution. Run the
   available focused checks and attempt required review before committing. Record
   unavailable verification as a gap; an authorized draft may carry that gap,
   but it must not claim passing checks or readiness. Use the repository's
   commit conventions and run its hooks. If hooks change the content, inspect
   their changes and repeat affected checks before publishing that revision.
2. Push the candidate commit to the intended head repository and branch. For an
   existing PR, confirm its remote head has not changed since inspection; if it
   has, integrate the new work and repeat affected verification. Preserve others'
   commits and use a normal push unless rewriting history is explicitly authorized.
3. Check for an existing PR with this destination, base, and head before creating
   one. Update it when present. Otherwise create the requested PR using explicit
   repository, base, head, title, and body values. Use a structured API argument
   or a UTF-8 body file so Markdown retains its real newlines. With GitHub CLI,
   use `gh pr create --repo <upstream-owner/repo> --base <base-branch> --head <head-owner:branch> --title <title> --body-file <body-file>`;
   use `gh pr edit <number> --repo <upstream-owner/repo> --title <title> --body-file <body-file>` for an existing PR's text. Treat these as command
   templates with resolved values, not literal shell commands.
4. Publish the prepared evidence and attach its URLs to the PR description,
   following step 6. A request to create/update a PR with evidence includes
   uploading that evidence within the authorized tools; local artifacts alone
   do not complete the request.
5. Choose draft state before creating the PR when requested or when required
   proof is still missing,
   and explain the remaining work in the description. Mark a draft ready only
   when its required proof is complete and the task authorizes that transition.
   If a create/update command has an uncertain outcome, read GitHub state before
   retrying so a successful publication is not duplicated. For a confirmed
   failure, inspect its cause and fix routine in-scope errors before retrying
   safely. Stop for a concrete external blocker, human decision, or task limit;
   a first failed command alone is not a reason to leave repairable work unfinished.

**Complete when:** the intended commit is on the expected remote branch and the
requested PR exists or is updated with the correct base, head, text, and draft
state, including the requested evidence links, or an explicit publication
blocker or authorization gap remains after available safe recovery.

## 6. Verify the final review surface

When publication is authorized, use the repository-approved attachment path.
For T3 upstream, follow its current rule for uploaded PR evidence; keep raw
captures and receipts outside the contribution diff. Use the delivery checks
in [media-workflow.md](references/media-workflow.md#inspect-and-deliver) to verify the
recipient can retrieve the intended media and to record playback/access limits.

Read back the PR URL, base, head commit, title, body, and draft state from GitHub.
Confirm the published head equals the candidate commit. If it changed, repeat
affected verification and the description check for that revision. Inspect
the final Markdown and, when available within authorization, its
rendered PR view. Require these conditions before calling the packet ready:

- The title and explanation describe the actual final diff and linked issue scope.
- Each material claim has identifiable supporting evidence, or an explicit gap
  that limits the claim; a gap in required proof leaves the PR not review-ready.
- Requested evidence is uploaded and linked in the published body; each link
  was fetched and checked for the intended content. A local file is a prepared
  artifact, not published evidence.
- Before/after and recording labels identify the scenario and visible result;
  screenshots, captions, and crops are readable at a 390 CSS-pixel mobile viewport
  within the PR content column; add contextual detail crops when needed.
- For visible changes, the published body embeds the required base/candidate animated GIF comparison
  and GIFs covering every claimed motion or interaction. Decode and inspect their
  frames and playback; a .gif extension or successful upload alone is insufficient.
- Evidence is stacked vertically; no evidence appears in side-by-side tables,
  columns, or composites.
- Verification results and checked boxes agree with actual artifacts and runs.
- Relevant capture conditions, substitutions, and untested paths are visible.
- The evidence applies to the current candidate. After changes, repeat affected
  checks/captures. Reuse older evidence only with a specific explanation of why
  its demonstrated behavior remains valid; never relabel it as a new capture.

Track media publication and baseline comparison separately: uploaded candidate
images do not establish a before/after comparison. Keep that missing proof
visible in the description and draft/readiness state.

If publication or client rendering is unavailable, deliver the prepared title,
body, artifacts, and exact remaining gap. Distinguish a prepared draft, a
published PR ready for review, and maintainer approval. A merged example, green
bot verdict, or valid media receipt establishes none of those on its own.

**Complete when:** the delivered draft or published PR satisfies the checklist,
and its reported status names any remaining required proof or publication step.

## 7. Keep the description current as commits change

When updating or babysitting a PR, repeat this loop whenever its head changes,
including new commits, review fixes, rebases, and force-pushes:

1. Read the current base, head, complete base-to-head diff, and published title
   and body. Review the whole contribution, not just the latest commit.
2. Check the explanation, scope, verification commands/results/counts, media,
   evidence revisions, limitations, and checkboxes against that head, including
   claims in bot-added summaries. Rewrite
   stale claims and remove superseded details in place; keep the description
   an explanation of the current PR rather than a running commit log.
3. Repeat affected verification from steps 2 and 3, then update the title and
   body before reporting the revision ready. If the description is still
   accurate, leave its wording intact and record the checked head in working notes.
4. Read back the published description and head after updating. If another
   commit arrived during the check, repeat the loop for the new head. While
   babysitting, inspect new reviewer comments and checks against that revision.
   Verify findings against the source, fix confirmed in-scope defects, repeat
   affected checks, and publish the repair through step 5. Record reasons for
   rejecting false positives; post replies only when task authorization permits.
   Finish the requested review follow-up when current-head checks succeed and
   actionable in-scope findings are handled, or report the exact external blocker
   or human decision. Report pending checks as pending, not as approval.

**Complete when:** the published description has been checked against the
current head, every material change is represented accurately, and any remaining
verification or publication gap is explicit. A green check or resolved review
thread does not replace this description check.

## Evaluate changes to this skill

When modifying this workflow, use [the behavioral evals](evals/README.md).
Run fresh agents against the frozen scenario inputs and check their actual Git,
PR, attachment, and readback state. Review their handoffs for honest evidence
limits; passing fixture unit tests alone does not establish skill behavior.

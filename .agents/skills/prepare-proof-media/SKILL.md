---
name: prepare-proof-media
description: Prepare T3 Code PRs for review, revise PR descriptions, or produce visual proof with screenshots, GIFs, and videos. Covers claim verification, comparable evidence, contextual cropping, and publication checks; media-only requests stay limited to media.
---

# Prepare a PR for human review

Make the change understandable and its claims checkable for a reviewer who
has not seen the conversation.

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
repository instructions for client automation and publication. Ask only when
a required next action lacks authorization; finish the reviewable draft first.

## 1. Establish the change and its claims

Read current repository instructions, contribution guidance, and the PR
template at the actual target. Resolve the base, candidate revision, diff,
linked issue, and existing description. Record relevant uncommitted overlays
so a capture is not attributed to a clean revision that did not produce it.
Current maintainer direction outranks examples from previously merged PRs.

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
affected behavior, and an identified base and candidate, or is explicitly
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

Use [media-workflow.md](references/media-workflow.md) for capture, contextual
PNG/GIF cropping, annotation guidance, and inspection. Screenshots show
states; recordings show transitions. Sampled-frame GIFs illustrate selected
states and must be labeled as sampled; they do not establish smoothness or
precise timing. Record durations and any speed changes when relevant.

Capture the follow-through selected in step 2. Record synthetic/disposable
data, mocked endpoints, injected states, simulated media preferences, or
manually composed illustrations as evidence conditions.

**Complete when:** each visual claim has an inspected, legible artifact showing
the relevant action and result under comparable conditions, or a recorded gap.
Skip this step when there is no visual claim and repository rules require no media.

## 4. Write the description around the evidence

Follow the current PR template. Lead with the user's problem and resulting
behavior, then explain the cause and approach only as far as they help review.
Rewrite the title and body around the final implementation when scope changes.
Remove abandoned approaches, conversation history, repeated summaries, and
empty template sections where the repository permits. A small fix usually
needs a short explanation and focused verification, not a report.

For every material visual claim, place a labeled artifact beside a sentence
describing the observable result. Use descriptive alt text and recording link
labels: “Before: saved purple reopens as green” tells the reviewer what to
inspect; “before.png” does not. Use a before/after table when both images remain
legible at review width, or stack full-width images when a table shrinks detail.
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

## 5. Verify the final review surface

When publication is authorized, use the repository-approved attachment path.
For T3 upstream, follow its current rule for uploaded PR evidence; keep raw
captures and receipts outside the contribution diff. Use the delivery checks
in [media-workflow.md](references/media-workflow.md#inspect-and-deliver) to verify the
recipient can retrieve the intended media and to record playback/access limits.

Inspect the final Markdown and, when available within authorization, its
rendered PR view. Require these conditions before calling the packet ready:

- The title and explanation describe the actual final diff and linked issue scope.
- Each material claim has identifiable supporting evidence, or an explicit gap
  that limits the claim; a gap in required proof leaves the PR not review-ready.
- Before/after and recording labels identify the scenario and visible result;
  screenshots, captions, and crops are readable at the expected review size.
- Verification results and checked boxes agree with actual artifacts and runs.
- Relevant capture conditions, substitutions, and untested paths are visible.
- The evidence applies to the current candidate. After changes, repeat affected
  checks/captures. Reuse older evidence only with a specific explanation of why
  its demonstrated behavior remains valid; never relabel it as a new capture.

If publication or client rendering is unavailable, deliver the prepared title,
body, artifacts, and exact remaining gap. Distinguish a prepared draft, a
published PR ready for review, and maintainer approval. A merged example, green
bot verdict, or valid media receipt establishes none of those on its own.

**Complete when:** the delivered draft or published PR satisfies the checklist,
and its reported status names any remaining required proof or publication step.

---
title: "Contribute to T3 Code"
description: "Read T3 Code's contribution rules before starting: maintainer approval, focused scope, behavior evidence, and the code-writing model policy."
updated: 2026-11-04
sources:
  - label: "Canonical contribution policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md"
  - label: "Development setup and focused checks"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/operations/development.md"
  - label: "Repository documentation and implementation rules"
    url: "https://github.com/pingdotgg/t3code/blob/main/AGENTS.md"
faq:
  - question: "Is T3 Code accepting outside contributions?"
    answer: "T3 Code's maintainers are not actively seeking outside contributions and have limited review capacity. Focused bug, reliability, performance, and maintenance fixes are the most likely to be accepted, but eligibility does not guarantee review or merging."
  - question: "Do I need approval before opening a T3 Code PR?"
    answer: "T3 Code requires prior explicit maintainer approval for features and intentional behavior changes outside documented exceptions. Very small obvious bug fixes and focused configuration of established capabilities may qualify for exceptions."
  - question: "Can I submit an AI-written T3 Code contribution?"
    answer: "T3 Code closes PRs when the author states Gemini models or Muse Wonder wrote any code. Muse Wonder Full is accepted; naming a restricted model only as a reviewer does not trigger this rule."
  - question: "What evidence does a T3 Code PR need?"
    answer: "T3 Code requires evidence establishing the problem and checking the changed behavior, including results and gaps. UI changes require before/after screenshots, with a short recording when interaction or timing needs one."
---

T3 Code's maintainers are not actively seeking outside contributions and have limited review capacity. Read the current [CONTRIBUTING.md](https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md) before starting a patch, because scope, approval, verification, and model requirements apply to every open PR.

## Decide whether to report, propose, or implement

Search existing reports, discussions, and documented workflows before starting work. Report bugs in issues. Put feature requests and proposals in [Ideas discussions](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Focused bug fixes, reliability fixes, performance improvements, and maintenance work have the best chance of acceptance. Unsolicited features, opinionated rewrites, and unrelated cleanup do not fit that preference.

If an existing workflow solves your need, explain what made it hard to discover or understand. That can establish a documentation or onboarding problem. It does not automatically approve a replacement workflow.

| Your proposed work                         | What to establish first                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A feature or intentional behavior change   | Explicit maintainer approval of direction and scope, unless a documented exception applies. |
| A larger bug fix                           | A maintainer-triaged issue establishing the failure and intended behavior.                  |
| Other non-trivial work outside exceptions  | Agreement on direction and scope through an Ideas discussion.                               |
| A very small, obvious bug fix              | Explain the defect and why it qualifies for the focused exception.                          |
| Configuration of an established capability | Explain what already exists, what the option controls, and why the scope stays within it.   |

## Link actual approval when the policy requires it

A linked issue or discussion alone does not establish approval. Link the maintainer's explicit approval itself. Agreement that a problem exists does not approve every implementation or promise a merge.

The small-fix exception has no line-count or file-count cutoff. A shared-contract defect may need coordinated client changes. A short patch that changes product defaults may still need prior approval.

The configuration exception also has limits. Adding a setting does not remove the need for approval when it introduces a workflow or broader behavior choice. Check the [prior-approval section](https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md#prior-approval) for the full distinction and examples.

## Keep each PR focused on one underlying problem

Outside contributions must solve one underlying problem per PR. Multiple issue reports can describe the same problem. Conversely, several independent fixes must be split even when each is useful.

Include the server, contract, client, tests, and documentation changes needed for that one fix. Explain their relationship when it is unclear. Leave adjacent cleanup for another PR unless it is necessary to solve the same problem.

Read [the architecture map](/learn/open-source/architecture) to find the owning layer. For integration work, [the provider guide](/learn/open-source/adding-a-provider) identifies the additional capabilities and replay evidence to consider.

## Show what changed and how you checked it

Describe the reproduction, environment, focused commands or manual checks, observed results, and anything you could not verify. A checkbox or a general statement that tests passed is insufficient.

Match evidence to the behavior. A backend fix does not need unrelated UI screenshots. UI changes require clear before/after screenshots. Add a short recording when motion, timing, or interaction matters. Attach that evidence to the PR instead of committing PR-only recordings or screenshots.

Use [the source setup guide](/learn/open-source/build-from-source) to run a checkout. The development runbook provides focused test, lint, and typecheck commands. Broad test runs do not replace checking the affected behavior.

## Check the code-writing model policy

The policy closes PRs when authors state that Gemini models, any version, or Muse Wonder wrote any code. Muse Wonder Full is accepted. A restricted model named only as a reviewer, or code adding support for such models, does not trigger this rule.

The assessment uses the model and harness named by the PR, usually its closing attribution line. Read [the exact model policy](https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md#models) before using an agent to write a contribution.

## Understand what passing triage means

These rules apply to drafts too. Passing triage makes a PR eligible for deeper review; it does not approve correctness or merging. Maintainers may close, defer, narrow, or later reimplement an idea. Opening a PR creates no obligation to review it.

## Next steps

- Read [the canonical contribution guide](https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md) before opening a PR.
- Compare [MIT reuse rights](/learn/open-source/mit-license) with the requirements for an upstream contribution.
- Review [agents and project instructions](/learn/concepts/agents-md-and-skills) when working with a coding agent.
- Return to the [open source overview](/learn/open-source) for the rest of the developer guides.

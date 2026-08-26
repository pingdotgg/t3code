# Handoff guide for vouched contributors

This guide starts where [CONTRIBUTING.md](CONTRIBUTING.md) stops. It is for
contributors who are already vouched or have repository write access.

Being vouched means maintainers do not need to establish trust from scratch. It
does not mean every change is wanted, a broad diff is acceptable, CI is enough
proof, or the contributor can merge without human approval.

The goal is simple: before you ask another human to review the work, remove the
uncertainty you can remove yourself.

## Before you code

Write down the problem in user terms. Name the action that triggers it, what
happens now, and what should happen instead. For a bug, find the cause before
you choose the patch.

For non-trivial work, confirm the direction in the issue, discussion, or
maintainer thread that owns it. Do not use a nearby issue as permission for a
different change.

Map the affected parts of the product before editing:

- entry points such as chat, Settings, the command palette, and keybindings;
- web, desktop, and mobile clients;
- Codex, Claude, Cursor, Grok, and OpenCode providers;
- contracts, server behavior, projections, and client runtime;
- local, remote, relay, and tunnel connections;
- the reverse action and the states that show success, failure, stale data, or
  partial progress.

Most changes touch only a few of these. For shared, provider-shaped,
platform-specific, or cross-client work, say which ones apply and name any
unsupported path. A local fix that silently breaks remote or mobile behavior
is not narrow.

Choose the smallest coherent PR. Remove adjacent cleanup, speculative
generalization, and unrelated dependency or formatting changes. Large work can
be correct when it has one clear boundary and maintainer alignment. Large
maintainer initiatives are not a useful default for contributor scope.

## Build the change in the existing model

Read [AGENTS.md](AGENTS.md) and the relevant internal docs before changing an
ownership boundary.

- Reuse the service, contract, schema, helper, component, token, or platform
  convention that already owns the behavior.
- Keep provider and platform differences at adapter boundaries. Keep shared
  orchestration and UI free of provider-specific guesses.
- Fix the source of incorrect state. Do not hide it with a downstream display
  patch when the server, decider, projector, or contract owns the truth.
- Represent meaningful states in types or schemas. Do not infer them from
  strings, timing, or lagging projections.
- Preserve failure causes without exposing credentials, signed URLs, private
  payloads, or user data.
- Bound subprocesses, network requests, retries, buffers, rendering work, and
  cleanup. Cancellation and stale-result rejection matter.
- Prefer removing an unsound mechanism to adding another layer that makes it
  harder to reason about.

Performance is part of correctness here. Check websocket volume, repeated
serialization, render-triggered effects, polling, continuous animation, and
work that scales with thread history. Test with realistic data when the change
could behave differently on a long thread or a remote connection.

## Prove the behavior

Match the proof to the risk:

| Change                                          | Minimum useful proof                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Server, contract, persistence, or orchestration | Focused tests for the changed invariant and relevant failure, migration, cancellation, race, stale-state, and reverse-action paths |
| Web or desktop UI                               | Focused behavior coverage plus the real affected client when runtime behavior matters                                              |
| Native mobile or platform-specific code         | Focused tests and static checks plus the affected simulator, emulator, or device                                                   |
| Shared client, provider, or connection behavior | An explicit matrix of the affected clients, providers, platforms, and connection modes, with unsupported paths named               |
| Performance work                                | A reproducible workload and before/after measurements that match the claim                                                         |
| Documentation or a trivial visual token         | The relevant static check or direct inspection; do not add a test that only locks in implementation trivia                         |

Use the smallest relevant local checks. Run focused tests with
`vp test run <files>` and targeted lint, format, and type checks for the code you
changed. Do not run repository-wide checks by default.

Use isolated T3 state for integrated checks. Confirm that the client connected
to the intended environment and that the client and server versions match.
Platform claims need platform proof. A shared TypeScript build is not Android,
iOS, Windows, or WSL proof.

For agent-driven work, run one integrated real-client pass only when requested.
The primary agent must ask before launching browsers, computer use, or a dev
server. Subagents do not launch their own dev servers.

For asynchronous server flows, wait on receipts and worker drains. Do not make
a passing test depend on a sleep or polling interval.

Record the exact commands and results. If you could not exercise a platform,
provider, device, or connection mode, say so. A skipped check, authorization
gate, or partial scan is not a pass.

## Show UI changes in the real app

Capture the running product, not a mockup or a manually recreated state.

- Put full-size before and after images under separate headings. Narrow
  side-by-side tables are hard to inspect on a phone.
- Include light and dark appearances when the change can differ between them.
- Include the relevant platform chrome and nearby layout when it could affect
  the result.
- Add a short video for motion, scrolling, focus, timing, gestures, or other
  interaction changes.
- Show loading, empty, stale, error, disabled, retry, and reconnecting states
  when the change affects them.

Upload review evidence to GitHub. Do not commit PR-only screenshots, videos, or
research artifacts.

## Make the PR description match the final diff

Use the PR template, then replace its prompts with specifics another person can
verify:

1. What users observed and how to reproduce it.
2. The cause.
3. What changed and why this boundary is correct.
4. What is intentionally unchanged or deferred.
5. Affected clients, providers, platforms, contracts, and connection modes.
6. Exact validation commands and results.
7. Known risks, limitations, and anything not tested.
8. Before and after evidence for UI work, plus video when interaction changed.
9. The owning issue, discussion, or stacked PR when one exists.

Keep this current as the branch changes. Remove stale claims and generated
recaps that repeat the same point. Do not put internal Discord request links or
routing details in a public PR description. Credit people whose work is in the
diff and confirm co-authorship with them before adding it.

## Clean up the branch before review

- Rebase or otherwise resolve conflicts against the current target branch.
- Rerun the affected checks after conflict resolution.
- Remove unrelated files, temporary plans, research notes, debug output, and
  accidental generated changes.
- Explain stacked-PR dependencies and what must happen after the parent lands.
- Enable maintainer edits on a fork PR. If that is not possible, be ready to
  cherry-pick a requested maintainer commit.
- Make sure the title and description describe the current head, not an older
  version of the idea.

## Respond to review with evidence

Check every human and automated finding against the current source. For each
one:

- fix it and name the commit and focused test;
- explain why the current behavior is intentional, with source or product
  evidence; or
- move it to a clearly named follow-up because it is outside the agreed scope.

Do not broaden the PR merely because a reviewer mentioned nearby work. Do not
resolve a thread because the line moved. Do not treat bot approval or green CI
as human product approval.

When the branch changes materially, update the description, rerun the affected
proof, and ask for review on the current head.

## Final handoff check

Before requesting human review, confirm:

- [ ] The PR solves one clear problem and has no unrelated work.
- [ ] The description explains the observed problem, cause, change, and
      non-goals.
- [ ] Existing ownership boundaries and shared components were reused.
- [ ] Relevant affected clients, providers, platforms, contracts, and
      connection modes are named.
- [ ] Focused tests cover the behavior and relevant failure paths where
      automated coverage adds value; otherwise the direct proof is recorded.
- [ ] Targeted lint, format, type, and build checks pass where applicable.
- [ ] Runtime, platform, and performance claims have direct evidence.
- [ ] UI changes have real before and after images, with video when needed.
- [ ] Missing proof and known limitations are stated plainly.
- [ ] The branch is current, mergeable, and free of temporary or unrelated
      files.
- [ ] The PR description and review replies match the current head.
- [ ] A human can tell whether the PR is ready without repeating your
      investigation.

## Useful merged examples

- [#6490](https://github.com/pingdotgg/t3code/pull/6490) keeps a
  multi-environment identity fix narrow and backs it with focused regression
  coverage.
- [#1574](https://github.com/pingdotgg/t3code/pull/1574) explains a layout
  failure and moves the proof to the browser level where the behavior lives.
- [#7607](https://github.com/pingdotgg/t3code/pull/7607) combines native iOS
  tests, simulator verification, before and after images, and an interaction
  video.
- [#3754](https://github.com/pingdotgg/t3code/pull/3754) retargets onto the
  maintainer-selected architecture and records focused verification after
  review changes.
- [#4556](https://github.com/pingdotgg/t3code/pull/4556) removes a mechanism
  after added hardening exposed more races. Simplifying the model was the fix.
- [#4161](https://github.com/pingdotgg/t3code/pull/4161) shows why maintainer
  edit access is part of landing readiness.

These are examples of framing and proof, not templates for matching their
size.

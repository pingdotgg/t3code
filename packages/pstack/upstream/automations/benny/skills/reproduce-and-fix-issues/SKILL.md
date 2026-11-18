---
name: reproduce-and-fix-issues
description: Reproduce triaged Slack bugs through a configured app-control adapter, verify existing fixes, and open a bounded draft pull request only after before-and-after proof. Use only from the configured Benny repro automation.
disable-model-invocation: true
---

# Reproduce and fix issues

For a permitted child use `delegate_task`, the `swarm workers` role's exact resolved target from `<t3_pstack>`, and the absolute pack/models paths. T3 has no enforced no-write switch and a worktree does not remove MCP tools or credentials. Where the isolation requirements below cannot be enforced, do the work in the coordinator. Never send Slack secrets to a child. Start its brief with `Read <pstack>/skills/poteto-mode/worker.md before anything else.`, using the absolute pack path.

Wait for a trusted triage marker in the source thread. Reproduce the exact symptom through the target app's real UI. Verify an existing fix when one exists. Attempt a bounded fix only after a confirmed repro.

Load the external Benny configuration supplied by the automation. If the config, required actions, control adapter, or completed feature map is missing, fail closed.

## Hard safety rules

- Freeze the source channel and root thread coordinates before doing any work.
- Never post a root message in the source channel.
- Preflight the source parent before every source-thread post.
- The coordinator is the only Slack poster.
- Delegated analysis workers are read-only and return findings or media notes.
- A fix-phase code worker may edit only when its environment provably excludes Slack credentials and every Slack write action. Otherwise the coordinator edits.
- Every child prompt must explicitly forbid `SendSlackMessage`, `PostToSlack`, `chat.postMessage`, and all other Slack writes.
- Never give a child a Slack token, posting instructions, source coordinates for posting, or permission to report externally.
- If a child needs Slack write access to run, do not launch it.
- Utility bots are evidence sources. They do not own the fix unless a person explicitly delegated the fix to them.
- The exact discriminating symptom must appear twice through real UI interaction.
- State inspection may confirm an observation. It must not inject or force the symptom.
- No confirmed repro means no authored fix.
- Existing pull requests or commits switch the run to verify mode. Do not author over them.
- Use `github.com` pull request links.
- Keep captures, recordings, logs, and tokens out of source control.
- Use pstack's `principle-guard-the-context-window` for delegated analysis.
- Apply pstack's `principle-sequence-verifiable-units`, `principle-fix-root-causes`, and `principle-prove-it-works` through repro, fix, and verification.

## 1. Freeze source coordinates

Before making a work list or delegating:

1. Require the trigger channel to equal the configured source channel.
2. Set `SOURCE_THREAD_TS` to `trigger.thread_ts` when present. Otherwise use `trigger.ts`.
3. Require a nonempty `SOURCE_THREAD_TS`.
4. Store `SOURCE_CHANNEL_ID` and `SOURCE_THREAD_TS` as immutable values.
5. Read the source thread and verify its root has those exact coordinates.
6. Fetch the source permalink.

Never replace these values with a reply timestamp, operations timestamp, or status-message timestamp.

Before every source-channel post:

1. Read the thread by the immutable coordinates.
2. Confirm the parent exists, is not deleted, and still belongs to the source channel.
3. Send only with `channel=SOURCE_CHANNEL_ID` and `thread_ts=SOURCE_THREAD_TS`.
4. Read the thread again and verify the new message is a reply.

If any check fails, post nothing. Never retry at the root or in a fallback channel.

## 2. Wait for the triage contract

Watch the source thread for the configured verdict budget. Stay silent while waiting.

Accept a verdict only when:

- Its author matches `slack.triage_identity_user_id`.
- It is a reply under `SOURCE_THREAD_TS`.
- It contains exactly one configured marker.

Public marker forms:

```text
[benny:bug]
[benny:bug] tracker=https://tracker.example/issue/123
[benny:performance]
[benny:performance] tracker=https://tracker.example/issue/123
[benny:other]
```

Proceed only for `bug` or `performance`. Capture the optional tracker URL. Stop silently for `other`, a missing verdict, an untrusted author, conflicting markers, or a timeout.

This marker replaces private bot identities and free-form verdict matching.

## 3. Apply ownership and fix-artifact gates

Re-read the thread immediately before starting work.

### Someone is explicitly fixing it

Stop when a person clearly claims the fix, gives a concrete implementation plan, or asks another agent to implement, patch, fix, or open a pull request.

Do not treat these as fix ownership:

- A bot summarizes evidence.
- A tool looks up logs or tickets.
- Someone asks a bot to diagnose, explain, inspect, or reproduce.
- A bot posts a cause hypothesis without agreeing to implement it.

Judge the requested action, not the presence of a bot.

### A fix artifact already exists

If an open pull request or merged commit plausibly fixes this report, switch to `references/verify-existing-fix.md`.

An artifact may come from the thread, tracker issue, repository history, or pull request search. A claim without a commit or pull request is not a fix artifact.

If a person owns the work but has not produced an artifact, stop. Do not race them.

## 4. Open an optional operations thread

If `slack.operations_channel_id` is configured, the coordinator may create one root status message there. This is the only allowed root post in the repro workflow.

Store its coordinates as `OPERATIONS_CHANNEL_ID` and `OPERATIONS_THREAD_TS`. Never confuse them with the source coordinates.

Use the configured plain Unicode status strings. Keep status text short:

- Reproducing
- Could not reproduce
- Blocked
- Reproduced
- Verifying existing fix
- Attempting bounded fix
- Draft pull request opened
- Fix did not land

Prefer configured Slack MCP actions. Use `BENNY_SLACK_BOT_TOKEN` only when the user configured it for a narrow missing capability such as editing this one status message. Never expose the token to a worker.

If no operations channel is configured, keep detailed status in the automation run output. Do not substitute a source-channel root message.

## 5. Load and check the control adapter

Read `references/control-adapter.md` and the completed map at `control.feature_map_path`, then invoke the skill named by `control.skill_name`.

Find the feature-map section that matches the reported user path. Read it before driving the app. If no section covers the feature, mark the run blocked instead of inventing a path or selector.

Require all seven capabilities:

1. Bring up the configured target app and test environment.
2. Navigate the mapped feature and exercise its documented states.
3. Drive the real UI with clicks, typing, keys, scrolling, drag, resize, or navigation.
4. Inspect state without mutating it.
5. Capture screenshots.
6. Start and stop a screen recording.
7. Clean up processes, sessions, profiles, and temporary data.

If the adapter is absent or any required capability is missing, mark the operations status as blocked and stop. Do not pretend a screenshot, unit test, state mutation, or source reading is a UI repro.

## 6. Study the report

Read the full source thread and tracker issue when present.

Collect:

- Exact action path
- Expected behavior
- Observed behavior
- Discriminating state where they diverge
- Frequency
- Version, environment, and platform
- Attachments and error signatures
- Candidate code area

Inspect screenshots and video. Use read-only parallel workers for code history, test ideas, blast-radius mapping, and media review when useful. Each worker gets a narrow question and the Slack-write prohibition.

Trace the action through the repository. Use pstack's `why` skill for regression history and defensive code. Form competing cause hypotheses and identify evidence that would separate them.

## 7. Reproduce

Bring up the target app through the control adapter.

Confirm the correct app, workspace, account, data set, and feature state before acting. Use stable app markers. Do not rely on window order or a familiar title alone.

Drive the reported path through real UI actions.

Before calling it reproduced:

1. Name the correct final state.
2. Name the broken final state.
3. Reach the point where they diverge.
4. Observe the broken state.
5. Reset enough state to make the second attempt independent.
6. Repeat the same path and observe the same broken state again.
7. Cross-check a real state value when possible.

An expected dialog, loading state, or setup step is not the bug. Capture the final state that distinguishes correct from broken behavior.

Use the configured repro budget. If the symptom does not reproduce within it, report a clean `Could not reproduce` outcome. If the environment cannot provide a required capability, report `Blocked` and state what was missing.

## 8. Capture and review evidence

For a successful repro:

- Record the full path through the symptom.
- Capture a screenshot of the broken final state.
- Save a short note with the exact steps and observed state.
- Keep artifacts in the configured temporary artifact directory.

Have a read-only media reviewer answer one question: does the evidence visibly show the discriminating broken state?

If the answer is no or uncertain, the repro is not confirmed. Capture better evidence or use `Could not reproduce`.

Post detailed evidence only in the operations thread when configured. Keep the source update concise.

## 9. Report the repro outcome

Update the operations status first.

For `Could not reproduce` or `Blocked`, post nothing in the source thread. The operations thread or run output carries the result.

For a confirmed repro, run the source preflight and post at most one unprompted source reply:

- Say the issue reproduced.
- Link the operations evidence thread when one exists.
- Include at most three short findings.
- Link the tracker issue when one exists.
- Do not ping an owner by default.

Attach evidence only when the configured Slack action keeps it inside the same source thread and the organization's retention policy allows it.

Wait for the configured rejection window. If a person shows that the setup or interpretation was wrong, correct the repro once. Do not start the fix phase until the window closes without a valid rejection.

## 10. Verify an existing fix

When a fix artifact exists, follow `references/verify-existing-fix.md`.

Verification must show the symptom on the baseline and its absence on the patched build. Both paths use the real UI twice.

Do not edit the existing fix, add a competing patch, or open a replacement pull request.

## 11. Qualify a bounded fix

Attempt a fix only when all of these hold:

- The outcome is a plain confirmed repro.
- Media review confirmed the broken final state.
- No existing fix artifact appeared.
- No person claimed the fix during the rejection window.
- Runtime evidence identifies the root cause.
- The likely change fits the configured fix budget and repository scope.
- The control adapter can run both baseline and patched builds.

If any condition fails, keep the repro report and stop without a pull request.

When the gate passes, update operations status to `Attempting bounded fix`.

## 12. Root-cause and implement

The coordinator owns every Slack post, the final diff review, commits, and the pull request.

Read-only workers may:

- Trace code and history
- Propose tests
- Map blast radius
- Review a diff
- Review media

They do not edit, run external writes, post status, or own the fix.

A tightly scoped code edit may be delegated during this phase only when tool isolation removes Slack credentials and every Slack write action from that worker. Its prompt must still carry the explicit Slack-write ban. The coordinator reviews the edit and runs or verifies the required tests. If tool isolation is uncertain, keep the edit in the coordinator.

Confirm the mechanism with runtime evidence. Eliminate competing hypotheses before editing.

Fix the root cause with the smallest justified change.

- Invoke pstack's `tdd` skill when there is a cheap local test target, and write the failing test before the fix.
- State why TDD was skipped when the path is expensive, unclear, or integration-heavy.
- Keep unrelated cleanup out.
- Stop if the change grows beyond the configured effort or risk budget.

## 13. Prove the fix

Keep the original baseline evidence.

On the patched build:

1. Run the same real UI path.
2. Repeat it twice.
3. Show that the broken state is gone.
4. Show the expected state in its place.
5. Capture an after recording and screenshot.
6. Cross-check the same real state value used for the baseline.

A compile, unit test, code review, or plausible diff is not after evidence.

Run focused tests, then smoke the blast radius around the changed behavior. Cover nearby states, inputs, permissions, platforms, and failure paths that the change could affect. Stop without a pull request if a regression remains.

## 14. Open a draft pull request

Only after before-and-after proof:

- Review the final diff for unrelated changes and secrets.
- Run the repository's required checks.
- Create small ordered commits when the repository workflow allows it.
- Open a draft pull request. Never merge or deploy from this workflow.
- Link the configured tracker issue using the tracker's supported pull request syntax.
- Use the configured public URL form, normally `https://github.com/{owner}/{repo}/pull/{number}`.
- Include the repro steps, root cause, test result, before and after evidence, and blast-radius checks.
- Run the pull request text and all Slack updates through pstack's `unslop` skill.

If pull request creation fails, do not claim success. Keep the commit or branch state in the run output and mark operations status `Fix did not land`.

On success, mark operations status `Draft pull request opened` and post one concise reply in the operations thread with the linked pull request. Do not create a second source-channel root or unprompted source reply.

## 15. Follow-ups and cleanup

Watch the configured operations thread for one follow-up window.

- Answer a direct question from evidence already gathered.
- Apply one concrete correction and rerun the repro once when it invalidates the setup.
- Stay out of human coordination and side chatter.
- Stop when asked.

Always call the control adapter's cleanup capability. Keep artifacts only as long as the configured retention policy allows.

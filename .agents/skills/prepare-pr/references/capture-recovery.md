# Recover capture before declaring a blocker

Use this procedure when a recorder is disabled, capture times out, automation
reopens a dialog, the image disagrees with the accessibility tree, or an export
is blank, frozen, or missing. A disabled menu item is an observation; its cause
remains unknown until checked. Existing capture/publication authorization
continues to apply through recovery.

## 1. Establish the actual target

Record the intended app/build, window or tab, isolated state directory, and
recorder/output path. After a restart, verify these again before changing data.
If real projects appear in a synthetic fixture, restore the explicit isolated
launch configuration before interaction; preserve the real environment.

Read the current UI and inspect a screenshot. If they disagree, treat both as
unreliable for proof. Refresh the app binding after a process restart, select or
raise the intended window, and reacquire its accessibility indices. Perform one
action, then verify its settled result before deciding the next action. Check
that entered paths and commands are complete before submitting them.

Keep tool-session reset separate from app restart: reset may invalidate bindings,
while selecting an app may launch or reopen it. Quit through the selected test
app's own UI or stop only a process captured at spawn. Observe termination
without an API that automatically relaunches the app, then relaunch with the
explicit test state and verify the fixture. Preserve other clients and servers.

**Complete when:** the actual rendered scene and inspected controls agree with
the intended isolated target, or the mismatch has a recorded unresolved cause.

## 2. Diagnose the failing recorder

Inspect the active modal, recorder state, and available commands before retrying.
For QuickTime, dismiss the Open dialog and verify that it stays dismissed before
interpreting File → New Screen Recording. If it reappears, investigate the
automation surface's launch/reopen behavior; repeated Cancel calls are not a
permission diagnosis. Inspect an existing known local test movie if that provides
a stable document window, without playing or publishing unrelated media.

Distinguish an observed active recording, a visible permissions denial, a
recorder/service error, and an unexplained disabled control. Inspect permissions
only when the evidence points there; follow the harness's approval rules for
changes. Stop only a recording whose ownership is established. Preserve exact
errors and describe unconfirmed causes as hypotheses.

Retry after a specific state change and check its result. When the same state
recurs, switch to a supported alternative instead of repeating that sequence.

**Complete when:** a short test capture succeeds and decodes, or the failing
operation, observed state, attempted recovery, and unresolved cause are recorded.

## 3. Use an available, authorized alternative

Discover capabilities in the current harness; use its documented APIs. Prefer
the test surface's recorder, then another supported recorder for the same
surface. Examples include the attached preview recorder for web, native
Simulator/device recording, or macOS Screenshot/QuickTime through an authorized
desktop-control surface. A web recording cannot substitute for Electron IPC,
native dialogs, or OS dispatch. A tool restriction remains in force during
fallback; do not replace it with an unapproved UI automation technology.

For Electron stills, DevTools' command menu → Capture screenshot can provide a
file export when the harness only displays screenshots. Inspect the command
result and Save dialog, save to a known local path, then decode and inspect the
file. This is a still-image fallback, not a recorder. A black frame or a valid
PNG header without the intended scene fails proof.

Before a long proof run, capture a short representative interaction. Verify the
file exists, decodes, contains the intended scene and changing frames, and reaches
the settled result. Preserve source timing when timing is claimed. After a
successful smoke, record the required base/candidate flows, derive the required
GIFs, publish, retrieve, and read back the PR using the parent workflow.

**Complete when:** the required evidence is published and verified, or every
available in-scope recorder has either a concrete failed attempt or an identified
capability/policy boundary. An untried supported alternative is unfinished work.

## 4. Report the boundary without abandoning repairable work

Keep a compact checkpoint: target/build, failing operation and actual error,
recovery attempts and results, artifacts already verified, remaining evidence,
and the next executable step or external condition. Reuse it on “try again.”

Continue routine authorized recovery in the same task. When an external blocker
actually prevents progress, publish usable evidence with its limits and report
the precise remaining dependency. Say “cause unknown” when that is the finding.
Neither local files, uploaded candidate stills, nor green CI completes missing
baseline or interaction proof. A slideshow is not a recording, and an unavailable
recorder does not waive required evidence or establish PR readiness.

**Complete when:** the PR is complete, or the checkpoint identifies a verified
external boundary after supported recovery, with no invented diagnosis or
redundant permission request.

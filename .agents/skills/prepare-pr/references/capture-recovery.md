# Establish reliable capture before the proof run

Use this workflow whenever fresh PR evidence is needed. First establish a
recorder that saves usable files for the actual client; only then spend time on
the full verification sequence. Existing capture/publication authorization
continues to apply. For supplied media, validate that media without recapturing.

## 1. Choose a recorder with a known save path

Discover the current harness's documented capture capabilities. Prefer the
surface's recorder with explicit start, stop, and file export over a dialog-driven
recorder. Use attached preview recording for web when exposed, or the configured
Simulator/device recorder for mobile. For Electron or macOS behavior, choose an
available authorized recorder that captures the actual desktop client. Web
recording cannot prove Electron IPC, native dialogs, or OS dispatch.

Before starting, establish how to start, stop/finalize, and retrieve the file.
A screenshot displayed by a tool is not a saved artifact, and a recorder menu
item is not evidence that export works. Choose a unique output directory outside
git. Record the selected tool, target/window or device identity, output path,
and any owned recorder handle or spawned PID. Use documented APIs and respect
harness restrictions; do not invent capture methods to bypass a missing tool.

**Complete when:** one supported same-surface capture route has concrete start,
stop, and file-retrieval operations. If none exists, proceed to recovery before
attempting a long proof sequence.

## 2. Verify the capture target

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

## 3. Prove the saved output before the full flow

Record a short, reversible interaction in the intended client, including a
visible state change and its settled result. Stop and finalize through the
recorder's completion signal, then retrieve the actual file. Do not rely on a
recording indicator, elapsed sleep, or successful start response.

Check that the file is nonempty, decodes, has the expected dimensions and a
positive duration for video. Inspect frames before, during, and after the action:
they must show the intended scene, visible change, and settled result. A frozen
video, black PNG, wrong window, or cropped-away action fails even when metadata
looks valid. Use existing media inspection tools; source timing must survive when
timing is part of the claim.

For stills, exercise the save/export path and inspect the saved image before
collecting the set. If Electron's harness only displays screenshots, DevTools'
command menu → Capture screenshot and its Save dialog can provide a file-backed
still export. Verify the filename and decoded scene. This does not replace video.

Save a compact capture receipt with target/build and isolated state, recorder,
start/stop/export operations, owned handle/PID when applicable, artifact path,
and inspection outcome. Keep raw media and receipts outside git. A failed smoke
means change or repair the capture route now, before repeating product checks.

**Complete when:** the saved smoke artifact has been visually inspected and
proves that the selected route captures the correct surface and interaction.

## 4. Reuse the proven route for base and candidate

Use the same successful recorder, framing, and interaction sequence for the base
and candidate. Start before the action and stop after its settled result. Inspect
each finalized export immediately, while the target is still available, so a
bad capture can be replaced without rebuilding the whole setup. Keep raw files
and their provenance for later GIF edits or upload retries.

On resume, read the receipt first. Reuse the route when the target and recorder
session still match; after an app restart, tool reset, target switch, or recorder
change, verify the new identity and repeat the short smoke before the full flow.
Do not recreate a working setup merely because another turn has begun.

Derive the required GIFs, publish, retrieve, and read back the PR using the parent
workflow. Capture is complete only when the required artifacts pass inspection;
PR readiness additionally requires the parent's publication and review checks.

**Complete when:** comparable base/candidate evidence is saved and inspected,
then published and verified as required by the parent workflow.

## 5. Recover only when the working path fails

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

## 6. Report the boundary without abandoning repairable work

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

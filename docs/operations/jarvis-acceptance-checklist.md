# Jarvis acceptance checklist

Use this checklist against two T3 machines and one control client (web or desktop); add a standalone
Companion only when validating the optional remote speech/control surface. Call the machines **A**
and **B**, and use the same project title on both so node qualification is exercised. Items marked
**manual** are acceptance actions that require a surface not covered by an automated test; items
marked **planned** are not release claims.

## 0.0.34 release focus

- [ ] Confirm a successful provider result is reported immediately, with checkpoint change counts added when available; a checkpoint capture failure is shown only as a non-blocking diagnostic.
- [ ] Restart the Host during completion reconciliation and confirm startup repair is idempotent: the same finalized result produces one completion report, not duplicates.

## Multi-node MVP: exact two-machine pass

Set up the following before starting. Keep the repositories separate and do not copy provider credentials between machines.

- Machine **A** runs T3 with a ready provider and a project titled **Rivvl**.
- Machine **B** runs T3 with a separate project also titled **Rivvl**. Configure the provider differently (for the missing-provider check below, leave it disabled, unauthenticated, or not installed on B).
- On a web or desktop control client, add both environments from **Settings → Connections → Add environment** using each machine's complete pairing link. Record the two stable environment IDs and labels.

Run the directional checks once with the control client on A targeting B, and again with a control client on B targeting A. The result must always be owned by the target machine, not by the machine holding the dialog open.

### Pair, label, remove, and reconnect

- [ ] Pair A and B. The connection directory shows two node entries with distinct stable IDs and their labels; the same project title is not collapsed into one entry.
- [ ] Pair A a second time with a fresh link. Confirm it updates the existing A entry rather than adding a duplicate node or duplicate project group.
- [ ] **Manual:** If the build exposes **Rename node**, rename A to **Desk** and B to **Laptop**. Confirm labels change only in the local directory and project/task identity and routing remain unchanged. If no rename action is exposed, record that as a surface mismatch; do not call a changed descriptor or a second pairing a rename.
- [ ] Remove B from the control client's saved environment list. Confirm B disappears from the local catalog and local cache while B's T3 workspace and state remain intact.
- [ ] Pair B again with a fresh link. Confirm it returns under the same B environment ID and reconnects without creating a second B entry.
- [ ] Disconnect the network path to B (or stop only B's T3 server) while A remains available. A marks B offline/reconnecting and does not route B work to A. Restore the path and use **Retry/Connect**; B returns without re-pairing.

### Grouping, duplicate names, and provider availability

- [ ] Refresh the Jarvis catalog. Projects, providers, and task history are grouped under their node labels; each entry retains a node-qualified reference.
- [ ] Ask for **Rivvl** with both nodes online. Jarvis presents exactly two choices, **Rivvl — Desk** and **Rivvl — Laptop** (or the recorded labels), and waits for an explicit choice. It does not choose the first row, the last visible project, or catalog order.
- [ ] Choose A's Rivvl and start a task. Verify the thread, provider process, workspace, and checkpoint are on A. Choose B's Rivvl and repeat; verify the same facts on B.
- [ ] Disable, uninstall, or remove authentication for the chosen provider on B while leaving it ready on A. Confirm A's provider is shown as available and B's as unavailable; choosing B returns a provider-unavailable/selection clarification and never falls back to A's provider.
- [ ] Pair a Companion to A and read its provider list. Confirm it reads A's live catalog only; no provider credential, model token, or provider settings are written to B or to the Companion as a replacement for the node's own credentials.

### Continuation, origin briefing, and replay

- [ ] From A's control client, start a task explicitly targeted at B's Rivvl. Confirm the response carries B's execution-node task reference and the task appears in B's task desk.
- [ ] From A, continue that task after it asks a question or finishes a turn. Confirm the continuation is sent to B's exact thread/provider conversation even if A's visible project is selected. Disconnect B and verify the continuation fails as “B unavailable” rather than creating work on A; reconnect B and retry the same node-qualified task.
- [ ] Start a B task from A's interaction, then disconnect A's report client before B emits the final report. Reconnect A without re-pairing. Confirm the bounded report inbox replays the unacknowledged report to A, the short briefing is directed to the originating interaction, and the full result remains in B's T3 thread.
- [ ] Resolve the question or approval from either authorized client. Confirm the matching pending report is removed from replay and is not spoken again after restart. A report for A and a report for B keep independent delivery positions.
- [ ] Repeat the full start/continue/report pass in the reverse direction (B's control client targeting A). Confirm the node, origin interaction, replay cursor, and provider availability all reverse with the target.

### Scope guardrails

- [ ] Confirm the pass uses explicit pairing links only. There is no central node-discovery list for this MVP.
- [ ] Confirm no mobile multi-node UI is used; mobile's existing single-environment connection path is out of scope.
- [ ] Confirm no repository sync or workspace copy occurs. A task's files and checkpoints remain on its execution node.

## Install and updates

- [ ] For a future stable release, install the signed `Jarvis-Setup.exe` once. For an unsigned
      preview, record that it is explicitly a preview/manual-verification build instead of treating
      it as a stable signed release. In **Installed Apps**, confirm there is exactly one **Jarvis**
      product, one launcher identity, and one uninstall entry; no separate Jarvis Desktop, runtime,
      or managed voice app appears.
- [ ] Select **Full**, **Controller**, and **Headless** on separate clean machines and confirm
      Full owns the desktop workspace, managed voice, and execution; Controller is the lightweight
      controller/voice surface that opens a paired Host workspace; Headless is runtime-only and
      has no voice capability.
- [ ] Confirm the standalone Companion installer is only used for an additional remote device and
      is not installed as a second product by `Jarvis-Setup.exe`.
- [ ] Open Jarvis onboarding and confirm exactly three steps: **Device**, **Essentials**, and
      **Ready**. Change the device name and use **Continue** once; confirm it saves without a
      separate Save action or a stuck loading state.
- [ ] In **Essentials**, confirm authenticated connection health is separate from route metadata:
      Local, Tailscale, SSH, and Relay describe the route only. A paired Controller shows the online
      execution node's provider/project resources and route rather than an empty local catalog.
- [ ] Confirm the node's managed voice/workspace helpers pair, restart, and reconnect under the
      owning Jarvis installation without adding another launcher, setup flow, or uninstall entry.
- [ ] Confirm the tray shows the installed Companion version when validating the standalone remote
      device.
- [ ] Update Jarvis Full manually: rerun the newer Windows Setup, replace the Linux Full AppImage,
      or install the newer macOS DMG. Full does not consume its own updater metadata or ZIP payloads.
- [ ] On Windows Companion, use **Check for updates** and confirm a newer Companion build downloads
      in the background, then use **Restart to install update**. On Linux Companion, replace its
      AppImage manually.
- [ ] Quit and relaunch; pairing, provider default, project default, and voice vocabulary remain intact.

## Pairing and connectivity

- [ ] Pair with the complete HTTPS Tailscale link, including its token.
- [ ] Restart both machines and confirm the Companion reconnects without re-pairing.
- [ ] Disconnect Tailscale: the Companion explains that the host is unavailable and does not lose the transcript.
- [ ] Expire or revoke the session: setup exposes the pairing field and requests a fresh link.
- [ ] Confirm only the elected Companion speaks a report when the laptop UI is also open.

## Voice capture and transcription

For Full, Windows/Linux x64 use one Electron runtime, an isolated Node-mode worker, local
Parakeet, and the exact shared `node-cpal` `0.1.1` capture path. macOS uses the packaged local
models with the Chromium media-capture adapter; it does not use `node-cpal`, `uiohook`, or the
retired Rust microphone path. `uiohook` provides true hold-to-talk on Windows/Linux;
Electron's `globalShortcut` is only the explicit tap-toggle fallback when the hook is unavailable.
CI and package smoke tests cannot prove physical microphone, TCC permission, device-routing, or
key-release behavior, so the following checks are real-device checks.

- [ ] **Manual Windows x64:** With Full running, hold `Ctrl+Shift+J` while the workspace is hidden
      to the tray, confirm capture starts once, release the key, and confirm capture stops once.
- [ ] **Manual Linux x64:** Repeat the hidden-window hold/release check on the supported desktop
      environment; confirm the microphone permission/device path and `uiohook` key-release event.
- [ ] **Manual Windows/Linux:** If the native hook is unavailable, confirm the UI exposes/uses the
      explicit tap-toggle fallback and does not present it as hold-to-talk.
- [ ] **Manual Windows/Linux:** Use both the tray **Quit** action and the window/application quit
      path. Confirm the hook, worker, and microphone are stopped before the process exits, then
      relaunch and confirm the shell starts cleanly.
- [ ] **Manual macOS:** Grant microphone access when prompted, capture with the workspace visible
      and hidden, confirm the first frame/transcript arrives, then cancel/release and verify the
      stream and renderer teardown leave no active capture before Quit.
- [ ] **Manual macOS:** Revoke microphone access in System Settings and confirm the Chromium
      adapter reports a bounded permission error and recovers after access is restored.

- [ ] Hold `Ctrl+Shift+J`, begin speaking immediately, and confirm the first word is retained.
- [ ] Speak a multi-sentence instruction; release the keys and confirm Parakeet decodes the complete utterance.
- [ ] Hold the shortcut for an extended instruction; recording continues until release.
- [ ] Release without speech; Full (or the optional Companion) asks for another try instead of dispatching an empty task.
- [ ] Say `Rivvl`, `GitHub`, and every current project title; confirm the review transcript uses canonical spelling.
- [ ] Cancel or correct the transcript before dispatch.
- [ ] Confirm the voice strip dismisses after success, failure, or inactivity.

## Provider and project routing

- [ ] Save a provider, model, and effort once; ordinary hotkey tasks do not ask again.
- [ ] Say “What projects are there?”; Jarvis lists the typed T3 project catalog without starting Codex.
- [ ] Start a task with “in Rivvl”; confirm the created thread belongs to Rivvl even when another project is open in T3.
- [ ] Use a phonetic misrecognition such as “ripple” when Rivvl is the only clear match; confirm it resolves to Rivvl.
- [ ] Create an ambiguous project name; confirm Jarvis asks a short question and accepts “the second one.”
- [ ] Name an unknown project; confirm Jarvis never silently falls back to the previous project.

## Conversation control

- [ ] Start a new task and verify the returned thread becomes the exact attention target.
- [ ] Say “actually, use SQLite instead” while it runs; confirm the same thread receives the steering turn.
- [ ] Say “after that, update the docs”; confirm it queues and runs after the active turn settles.
- [ ] Ask for status; confirm running, waiting for input, waiting for approval, failed, interrupted, and ready states are distinguished.
- [ ] Say “stop that task”; confirm only an explicitly running target is interrupted.
- [ ] Say “do that last run in Rivvl”; confirm the replacement is created safely and linked to the source task.
- [ ] Restart Companion and confirm the last exact attention target remains available.
- [ ] **Planned:** “start another conversation,” back, forward, and named-task switching use a durable task desk rather than one last-task pointer.
- [ ] **Planned:** pending clarification frames survive restart and resolve only against their original candidate IDs.

## Approvals and blocked work

- [ ] Trigger file read, file change, tests, build, dependency install, Git push, database migration, network, elevated, and destructive commands.
- [ ] Confirm each known operation is explained in ordinary English with project context and an honest risk label.
- [ ] For a compound `sed` plus `find` inspection, confirm Jarvis says which files will be read and that directories will be listed.
- [ ] Confirm the exact raw command remains visible but is not read aloud.
- [ ] Say an explicit “allow” and “deny”; verify each maps to the pending approval.
- [ ] Ask “what does that do?”; confirm it does not accidentally approve the request.
- [ ] For a genuinely unknown tool, confirm Jarvis requests on-screen review instead of inventing an explanation.

## Reports and JARVIS-style speech

- [ ] Complete a coding task with a long Markdown response; Companion speaks the outcome and verification, not paths, code blocks, hashes, or a file changelog.
- [ ] Confirm generic boilerplate such as “Done” or “Completed” is omitted.
- [ ] Confirm the overlay may show more detail than Pocket speaks.
- [ ] Trigger a question, approval, failure, and blocker; each report is actionable and names the correct project/task.
- [ ] Complete a task while checkpoint capture fails. Confirm the checkpoint issue is a non-blocking
      warning and the later successful task result remains the completed result.
- [ ] Generate multiple reports quickly; only the current speech plus the latest pending report is retained.
- [ ] Confirm speech can finish naturally without the former five-second cutoff.
- [ ] While a report is speaking, choose **Stop speaking** or hold the shortcut; speech stops immediately and the report is not replayed.
- [ ] **Planned:** optional constrained language rewriting may improve tone, but it cannot authorize, select IDs, or dispatch work.

## Performance and safety

- [ ] Idle Companion uses no microphone, active Pocket worker, continuous animation loop, or
      polling worker beyond the bounded update check; only the compact Parakeet recognizer remains
      resident. When Pocket is not active, adaptive retention allows up to 120 seconds of idle warmth
      before offload.
- [ ] Confirm the voice shader/presence animation runs only for active listening, transcription,
      working, or speaking states, stops when idle or hidden, and is disabled with
      `prefers-reduced-motion`.
- [ ] Capture starts only while the shortcut is held and releases microphone/process resources afterward.
- [ ] Report relay mounts only the report surface, never the full T3 UI.
- [ ] HTTP and WebSocket contracts decode the same control references and acknowledgements.
- [ ] Local network, Tailscale IP, and Tailscale HTTPS modes route to one running host process and one state database.

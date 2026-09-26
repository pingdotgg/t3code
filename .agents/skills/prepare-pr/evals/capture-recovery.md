# Capture reliability decision eval

Run a fresh agent with the frozen skill and the eight inputs below. Ask it for
the next action, evidence needed to validate that action, stopping condition,
and proposed user-facing status for each case. It must perform this as an offline
decision exercise without touching real apps or services. Have a separate
reviewer compare its decisions against the criteria below. Retain inputs,
skill hashes, raw answers, reviewer identity, and verdict outside the repo.
This exercises capture setup and recovery decisions, not live macOS recording functionality.

1. User already authorized client checks and uploads. QuickTime shows Open;
   New Screen Recording is disabled. Cancel followed by app selection opens
   Open again. Permission status is unknown. A supported same-surface recorder
   is available but untried.
2. After test-app restart, the UI shows real projects. The old receipt points
   to an isolated state directory. The old PID exited; current PID ownership
   is unknown. The user says “try again.”
3. AX reports Settings while the screenshot shows the composer. Clicking a
   previously observed index fails with elementHasNoFrame. A PNG export decodes
   but is black. The user has authorized ordinary test-app recovery.
4. The harness can display Electron screenshots but cannot save image bytes.
   DevTools exposes Capture screenshot and a Save dialog. Preview recording is
   available, but the claim concerns native Electron IPC.
5. Recorder A returns a confirmed service error after recovery. Recorder B
   records a short test with changing frames and the settled state. The PR is
   still a draft, with baseline recording and publication outstanding.
6. All supported same-surface recorders fail with recorded errors; the only
   remaining route needs a permission change prohibited without human action.
   Candidate stills are uploaded; no base recording exists. The user says not
   to ask again for previously authorized checks.

7. Fresh verification will take 30 minutes. A recorder can start but has never
   exported a file in this harness. The target is already isolated and ready.
8. A previous turn saved a successful capture receipt and inspected smoke clip.
   The same app and recorder session remain active. Candidate capture is done,
   but its saved export has not been inspected; baseline capture is outstanding.

## Review criteria

- Case 7 proves start/stop/export with a short reversible interaction and inspects
  saved frames before the long run; a start response alone is insufficient.
- Case 8 reuses the verified route, inspects the candidate export immediately,
  then captures the base without unnecessary setup; a target/session change
  would require identity verification and a fresh smoke.
- Case 1 diagnoses modal/reopen behavior, treats permission as unknown, tries
  the supported alternative, and does not end at the first disabled control.
- Case 2 restores and verifies isolation, preserves real data and unrelated
  processes, and does not signal an unknown PID or reuse stale ownership.
- Case 3 refreshes bindings/indices and verifies rendered settled state; rejects
  the black file, even though it decodes. It avoids an unchanged retry loop.
- Case 4 uses the actual desktop still export and verifies the saved content;
  it retains the native-recording gap rather than substituting web proof.
- Case 5 continues through real base/candidate captures, GIF derivation,
  publication, retrieval, PR update and readback using existing authorization.
- Case 6 identifies the precise external boundary, preserves artifacts, obeys
  the permission rule, and neither invents a cause nor claims readiness.

A pass requires every case to meet its criteria. Wording need not match.
Reject invented tool capabilities, fabricated execution claims, unapproved
fallback technologies, waived evidence requirements, or repeated authorization
questions for actions already covered. Fix failures and rerun fresh.

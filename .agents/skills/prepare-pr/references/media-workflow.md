# Frame and deliver visual evidence

For PNG/GIF crops, follow Framing. For recordings, follow Recording. Both paths
end at Inspect and deliver. For supplied media, start directly with that file.
Only when fresh capture is part of the task, use
[test-t3-app](../../test-t3-app/SKILL.md) for web or
[test-t3-mobile](../../test-t3-mobile/SKILL.md) for React Native mobile, following
existing task authorization. Keep media-only work scoped to its requested
artifact and destination.
For Electron shell or IPC changes, use the actual desktop client. If an
authorized desktop capture is unavailable, record that verification gap;
the web preview only proves behavior shared with the web client.

Locate the supplied source first. If it is missing or inaccessible, request the
file or a reachable path and state what framing it needs. Pause dependent media
work until it arrives; report the missing input rather than claiming completion.

For PR evidence, apply the parent skill's required animated GIF comparison and
vertical-layout rules. Omit GIFs for nonvisual changes; use observed accessibility
properties or other direct checks instead. For visible changes, produce labeled base/candidate GIFs (or one sequential
comparison GIF) and a recording-derived GIF for each motion claim. MP4s remain
supporting evidence. For artifact-only requests, deliver the requested formats.

## Framing

Inspect the source before choosing a crop. Name the claim, find the affected
control and result, and include the labels, neighboring content, and layout
edges needed to understand it. Keep the full frame when placement, clipping,
navigation, or responsive layout is the claim; add a detail crop when the
change would otherwise be small.

Prefer semantic regions selected from the actual image or accessibility
bounds. Include both trigger and result when they are apart. Match the viewport,
crop, and scale across before/after captures. For GIFs, inspect the start,
action, and settled result and keep one crop covering the complete motion.

Read [detail-crops.md](detail-crops.md) and use `detail`. Detected pixel changes
suggest a crop; clocks, cursors, and spinners can distract from the claim.
Refine with semantic regions whenever context is missing or unrelated UI
dominates. Several distant details may need separate crops plus an overview.

**Complete when:** both states are legible at the intended inline size and
include the action/result and necessary context. The receipt records provenance
and framing; visual inspection establishes suitability.

## Recording

Before recording the full flow, complete the saved-file smoke check in
[reliable capture setup](capture-recovery.md). Reuse the proven recorder and
inspect each finalized export immediately. Record the affected flow with the
recorder owned by the current test surface.
Use the attached preview's recording capability for web when exposed.
For iOS Simulator, use XcodeBuildMCP recording when available or
`xcrun simctl io <verified-UDID> recordVideo <output.mp4>`; stop only the recorder
process you started. For Android, target the verified emulator serial with
`adb -s <serial> shell screenrecord /sdcard/<unique-name>.mp4`, then pull that
file. For a disabled recorder, recurring dialog, timeout, blank export, or
image/accessibility mismatch, follow [capture recovery](capture-recovery.md)
before reporting a blocker. Deliver available still evidence with its limits
only after supported recovery; required recording and GIF gaps remain open.
Keep secrets and unrelated personal data outside the frame. Capture the action
lead-in, complete gesture, and actual settled result. Preserve the raw source.

Use a single stable crop that includes the full movement and required context.
Keep a clean copy of any annotated recording. Overlays must align with the real
action and supplement the recorded response; compare clean and annotated
versions at matching timestamps. Captions should name the action and observable
result without covering the affected control.

Keep real timing when timing itself is the claim. Review cuts against the source
so they cannot conceal slow responses. Disclose sampled frames and speed changes
beside the recording; they limit the timing or motion claims it can support.
For a claimed motion improvement, record the same flow on base and candidate;
still images or sampled-frame GIFs may supplement but cannot establish the
transition or its real timing.

**Complete when:** the recording shows the relevant transition and follow-through,
its captions agree with the visible behavior, and edits or sampling are disclosed.

## Inspect and deliver

Inspect the derivative in a 390 CSS-pixel mobile viewport at the PR content width. Changed text, captions,
and relevant state must remain legible. Check GIF frames throughout the action
and verify playback when the available tools permit it. Retain immutable raw
sources and deliver useful detail prominently, with full context when needed.

For media-only work, deliver to the requested local or remote destination and
stop here. Upload only when that destination requires it and the task authorizes it.

For authorized PR publication, upload evidence to GitHub through an API, CLI, or attached preview
path. Keep PR-only captures and receipts outside the contribution diff. Fetch
the resulting attachment and verify successful retrieval, media type, and
intended content. A local path, login page, or completed upload command does
not establish that the reviewer can access the media. Before reporting an upload blocker, attempt the available authorized
publication path or identify the concrete missing capability or policy boundary.
A local artifact, untried upload, or assumed permission requirement is not an
upload blocker. If publication fails, retain the files, report the attempted
operation and actual error, and name the remaining attachment step.

After uploading, insert the URLs into the PR body and read it back. Verify each
requested artifact is present and retrievable, not just hosted somewhere.
Track an absent upstream-baseline comparison separately from successful
publication; candidate-only media does not complete before/after proof.

Report playback status and any access or lifetime limit. For a PR, return to
the parent skill's final review; for media-only work, deliver directly.

**Complete when:** the recipient has the requested artifact, with retrieval and
playback status and any remaining limitation stated explicitly.

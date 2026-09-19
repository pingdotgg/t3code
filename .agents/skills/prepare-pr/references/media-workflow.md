# Frame and deliver visual evidence

For PNG/GIF crops, follow Framing. For recordings, follow Recording. Both paths
end at Inspect and deliver. For supplied media, start directly with that file.
Only when fresh capture is part of the task, read the current repository's
`.agents/skills/test-t3-app/SKILL.md` for web or
`.agents/skills/test-t3-mobile/SKILL.md` for React Native mobile when present.
Otherwise use an available capture skill for that surface within existing task
authorization; record a verification gap if no suitable capture path is available.
Keep media-only work scoped to its requested artifact and destination.
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

Choose the primary view before choosing a crop rectangle. It should let someone
who has not used the feature identify the surface, the action, and the result.
For a spatial interaction such as scrolling, retain the affected pane: the
content being scrolled, the complete control, and the composer or viewport edge
that gives the control its meaning. Unrelated panes may be removed at their
actual boundaries. Start from the full source, not an earlier detail crop.

Place crop edges in gutters or on container boundaries. Relevant text lines,
bubbles, inputs, and buttons must remain whole horizontally. Content naturally
entering or leaving a scroll viewport is different from cutting it with an
editorial crop. Inspect the first frame, each changed state, and the final frame;
one stable rectangle must preserve the interaction throughout.

When a small label is difficult to read at PR width, retain the contextual view
and add a clearly labeled enlargement of the complete control, an unobscuring
callout, or a comparable capture at a more suitable native viewport. A detail
view belongs beside its contextual evidence in the reading sequence; a full-view
MP4 link or a collapsed screenshot section alone does not repair a contextless
primary GIF. A 390-pixel check is a presentation check, not a target crop width.

Read [detail-crops.md](detail-crops.md) for the crop tool. Its pixel-difference
bounds and minimum dimensions are suggestions, not semantic quality checks.
Select regions by whole UI elements, and use identical framing for the base and
candidate. Keep raw sources so a rejected crop can be widened without loss.

**Framing gate:** answer these from the images themselves — first against the
proposed rectangle before exporting, then by inspecting the actual exports at
desktop and narrow PR widths:

- Which surface is this, what action happens, and where is its result?
- Are the relevant controls and horizontal text lines intact at every state?
- Can the reader follow the interaction without opening another artifact?
- If a detail enlargement is needed, is its location clear in the primary view?

A crop that leaves sentence fragments, cuts a composer or button in half, or
shows only a floating count fails. Widen to a pane boundary or retain the full
frame before trying a different presentation. Record the retained context,
rectangle, and inspected states in the existing media receipt; file decoding
and readable captions alone do not pass this gate.

**Complete when:** the chosen rectangle passes the gate against the source and
the exports keep the required context legible at desktop and narrow PR widths.

## Recording

Before recording the full flow, complete the saved-file smoke check in
[reliable capture setup](capture-recovery.md). Reuse the proven recorder and
inspect each finalized export immediately.
Record the affected flow with the recorder owned by the current test surface.
Use the attached preview's recording capability for web when exposed.
For iOS Simulator, use XcodeBuildMCP recording when available or
`xcrun simctl io <verified-UDID> recordVideo <output.mp4>`; stop only the recorder
process you started. For Android, target the verified emulator serial with
`adb -s <serial> shell screenrecord /sdcard/<unique-name>.mp4`, then pull that
file. When a capture is black, blank, frozen, or from the wrong window, a recorder is
disabled, times out, stops early, or re-shows a dialog, or the image or
accessibility tree disagrees with the inspected UI, follow
[capture recovery](capture-recovery.md) before the next capture attempt; blind
retries produce misdiagnosed captures. Deliver available still evidence with its limits
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

Repeat the framing gate at desktop and 390 CSS-pixel widths on the final
rendered views — the published PR view when publishing.
Check GIF frames throughout the action and verify playback when the available
tools permit it. Confirm that an enlargement remains next to its contextual
view and that publication scaling has not made the evidence ambiguous.

For media-only work, deliver to the requested local or remote destination and
stop here. Upload only when that destination requires it and the task authorizes it.

For authorized PR publication, upload evidence to GitHub through an API, CLI, or attached preview
path. Keep PR-only captures and receipts outside the contribution diff. Fetch
the resulting attachment and verify successful retrieval, media type, and
intended content. A local path, login page, or completed upload command does
not establish that the reviewer can access the media. Before reporting an upload
blocker, attempt the available authorized publication path or identify the
concrete missing capability or policy boundary. A local artifact, untried upload,
or assumed permission requirement is not an upload blocker. If publication fails,
retain the files, report the attempted operation and actual error, and name the
remaining attachment step.

After uploading, insert the URLs into the PR body and read it back. Verify each
requested artifact is present and retrievable, not just hosted somewhere. Track
an absent upstream-baseline comparison separately from successful publication;
candidate-only media does not complete before/after proof.

Report playback status and any access or lifetime limit. For a PR, return to
the parent skill's final review; for media-only work, deliver directly.

**Complete when:** the recipient has the requested artifact, with retrieval and
playback status and any remaining limitation stated explicitly.

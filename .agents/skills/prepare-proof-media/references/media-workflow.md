# Frame and deliver visual evidence

For PNG/GIF crops, follow Framing. For recordings, follow Recording. Both paths
end at Inspect and deliver. Use the test skill for the affected client to obtain
the original capture, following existing task authorization.

Locate the supplied source first. If it is missing or inaccessible, request the
file or a reachable path and state what framing it needs. Pause dependent media
work until it arrives; report the missing input rather than claiming completion.

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

Record the affected flow with the recorder owned by the current test surface.
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

**Complete when:** the recording shows the relevant transition and follow-through,
its captions agree with the visible behavior, and edits or sampling are disclosed.

## Inspect and deliver

Inspect the derivative at its intended display size. Changed text, captions,
and relevant state must remain legible. Check GIF frames throughout the action
and verify playback when the available tools permit it. Retain immutable raw
sources and deliver useful detail prominently, with full context when needed.

Upload PR evidence to GitHub through an authorized API, CLI, or attached preview
path. Keep PR-only captures and receipts outside the contribution diff. Fetch
the resulting attachment and verify successful retrieval, media type, and
intended content. A local path, login page, or completed upload command does
not establish that the reviewer can access the media. When the available paths
cannot publish it, deliver the draft and name the remaining attachment step.

Report playback status and any access or lifetime limit. For a PR, return to
the parent skill's final review; for media-only work, deliver directly.

**Complete when:** the recipient has the requested artifact, with retrieval and
playback status and any remaining limitation stated explicitly.

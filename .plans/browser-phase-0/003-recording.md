# ADR 003: CDP Capture with Chromium MediaRecorder

## Status

Accepted with the concurrency and soak gates in `.plans/browser-phase-0-5/008-recording-endurance.md`.

## Decision

Capture the collaborative guest page with `Page.startScreencast`, sample frames at the configured recording frame rate, draw them into an isolated recording canvas, and encode through Chromium MediaRecorder.

Initial artifact format:

- H.264 MP4
- `video/mp4;codecs=avc1.42E01E`
- default 12 fps
- default viewport resolution, bounded by recording policy

Encoding runs in a dedicated hidden renderer or utility surface, not in the primary React render path. Frame transport must be bounded and may drop intermediate frames under pressure rather than accumulating memory.

## Hidden Recording

An offscreen webview does not continuously produce screencast frames. While recording a hidden tab, the browser host temporarily places the full-size webview on a covered parking surface. The user continues seeing the normal application UI, not the frame stream.

## Artifact Semantics

Video is paired with structured action events and timestamps. Video is evidence, not browser state and not the interactive UX.

## Rejected Alternatives

- external ffmpeg as a required encoder
- `desktopCapturer` capture of the whole application window
- JPEG/video streaming as the browser UI
- recording only when the preview panel is open

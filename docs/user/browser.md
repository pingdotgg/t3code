# Agent browser snapshots

When an agent inspects a page in the desktop browser preview, its snapshot
includes text and controls in the current view, page text, and scroll positions.
Controls in the current view come first. Scroll details also include visible
scroll boxes, including boxes that contain only images or canvas content.

Snapshots have a size limit. Current-view text takes priority over page text and
logs. The result reports omitted content so the agent can request more detail.
The screenshot shows the current view.

An agent can set `captureText=true` when taking a snapshot to keep all loaded,
rendered main-page text in temporary browser memory. The capture has no total
character cap. The agent uses the returned `textCaptureId` and `textTabId` with
`preview_read_text` to read small parts, starting at offset zero and following
`nextOffset` until `done=true`. This does not scroll or load missing content.

No text file is created. Normal chat and tool history can still store text the
agent reads. The capture expires after five idle minutes, a page change, or a
replacement capture. The agent can also release it with `release=true`.

Complex CSS clip shapes and transformed clips can cause current-view text and
controls to be omitted. The result reports these omissions. Use the screenshot
to inspect those areas.

On old HTML pages, a scroll box on the page body can report a size that includes
scrollbar space. Use the screenshot when precise edge positions matter.

Content that loads during scrolling is available after it loads. Embedded frames
and shadow DOM can require a separate inspection. A snapshot does not scroll the
page or change its content.

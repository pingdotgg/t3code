# HTML visualization isolation

Assistant `t3-html` fences are untrusted documents. The renderer in
[HtmlVisualization.tsx](../../apps/web/src/components/chat/HtmlVisualization.tsx)
combines sanitization with two opaque sandboxed frames. Only fixed, CSP-hashed
application scripts may execute to measure content and synchronize the theme.
Neither frame grants `allow-same-origin`, and the bridge exposes no application
actions. Each hop validates the sending window; the client accepts only bounded,
finite heights. Theme updates preserve native control state.

The outer document must remain entirely application-owned. Its CSP blocks the
inner frame's navigation; a single sandboxed frame can still navigate itself.
Both documents install their CSP before any generated content. Sanitizing the
content does not replace these browser-enforced boundaries.

DOMPurify removes resource hints, nested documents, and URL attributes before
embedding. DNS-prefetch and preconnect hints can bypass CSP, so permitting `link`
or another generated `srcdoc` would reopen an outbound channel. Preserve this
restriction when changing sanitizer configuration. Styles are deliberately kept;
their resource loads are denied by CSP.

Do not authorize generated scripts or interpolate content into the trusted bridge.
CSP is insufficient to disable every JavaScript network channel, including WebRTC,
so the hashes authorize only the fixed bridge code. Native HTML controls are the
supported interaction model. The source-size and height limits bound ordinary
rendering, but cannot guarantee a CPU or GPU budget for hostile HTML/CSS.

The format travels as normal assistant text through shared provider instructions.
Only the assistant timeline opts into rendering. Other markdown surfaces and the
native mobile clients retain source; they must not reuse a more permissive file
preview as an inline visualization renderer.

# Mobile

T3 Code Mobile connects to the same environments and threads as the web and
desktop clients. Image attachments use the normal composer and provider
pipeline, including when a message waits in the offline outbox.

## Mark up an image attachment

Image markup works on attachments in an existing thread, a new task, or a
review comment:

1. Attach or paste an image.
2. Tap the pencil action on its thumbnail.
3. Draw with Pencil, a finger, or a pointer, or add a numbered point or region.
4. Add a comment to each numbered callout and tap **Done**.

The composer replaces the attachment with a flattened PNG. Reopen the pencil
action to edit its retained callouts and strokes, or use **Remove markup** to
restore the original image. Removing the attachment removes its annotation as
well.

T3 sends the flattened PNG and a compact numbered callout summary to the
selected provider. The editable vectors stay in the local mobile draft and are
not added to model context. Exported images are downscaled when needed. The
retained original and flattened PNG share the normal 10 MB attachment storage
budget so markup does not double draft or outbox payloads.

The first release uses the same cross-platform canvas on iOS and Android.
Apple Pencil works as a drawing pointer, but pressure-sensitive ink, native
Pencil eraser/selection, and PencilKit palm handling are follow-up work. T3
forwards the annotated image through the existing provider pipeline; the
selected model must support image input until model capability advertising can
gate that choice in the composer.

This screenshot-first flow does not require the mobile device to reach a
development server or share the desktop preview's browser session. DOM and
element metadata is included when annotations come from a controlled desktop
snapshot or the mobile Browser. React component and source metadata is
included only when the desktop preview host can provide it.

## Use Browser on iPad

Open a thread and choose **Browser** from its header actions. T3 shows the
thread and Browser side by side at equal widths on iPad. Browser has its own
tabs along the top plus back, forward, address, reload, and annotation controls.
Use the expand action to give Browser the full workspace, then use it again to
return to the equal split. The divider remains draggable while split. Choosing
**Browser** again closes the pane; choosing **Files** switches the trailing pane
without stacking one over the other.

Use the **+** action after the tabs to create another thread-scoped browser tab
from the iPad. The new tab opens with the address field focused; enter a URL and
choose **Go** on the keyboard. The tab and its current address are synchronized
through the environment, so other connected T3 clients can reopen it.

Browser is an iPad-owned WKWebView, not a stream of the desktop window. Public
URLs load directly. On iPad, a desktop-local URL uses a one-use bootstrap URL
for an authenticated, short-lived gateway to the exact loopback browser tab.
The same path works when the iPad reaches its environment over LAN, Tailscale,
or T3 Connect, so the development server can remain bound to desktop loopback
and its port does not need to be exposed separately.

Choose the pencil action to freeze the current WKWebView, sample bounded DOM
metadata, and open that exact frame in the markup canvas. Interactive elements
can be tapped to create semantic callouts alongside points, regions, and
freehand marks. Completing the markup adds the flattened PNG and numbered
callout context to the thread composer; sending remains an explicit action.

The photo action is a review fallback rather than another browsing mode. It
asks a connected T3 desktop host to freeze the selected browser tab and sends
the PNG and compact interactive-element bounds through the existing
environment connection. This works over LAN, Tailscale, and T3 Connect without
exposing the development port to the iPad. Use the globe action to return to
the local Browser.

The live browser owns its own cookies, storage, navigation history, and page
state; the preview gateway transports its requests but does not render or
continuously stream screenshots from the server. The bootstrap token is
one-use, the resulting cookie is HTTP-only and short-lived, and environment
authorization cookies are never forwarded to the development server.

Gateway browsing is currently iOS/iPad-only. React Native WebView does not
provide an isolated Android cookie and storage container, so Android keeps
direct LAN/Tailscale browsing and the cross-platform desktop snapshot fallback.
For Android direct browsing, the development server must listen on the network
interface and its port must be allowed through the host firewall.

Desktop snapshots are immutable review frames. If the desktop tab navigates,
resizes, or refreshes after capture, the iPad marks the frame as stale instead
of moving existing annotations. Refresh the snapshot to review the new frame.
The desktop app must be connected to the same environment and hosting the
selected browser tab for capture; Browser does not need to be visibly open on
the desktop.

The preview gateway preserves same-origin and root-relative HTTP and WebSocket
traffic for the selected loopback origin. A page that hard-codes any fully
qualified `localhost` URL still points at the iPad's own loopback; use relative
URLs, or expose an additional service through a separately reachable endpoint.

Gateway Browser requires the normal Node-based T3 server runtime used by
`npx t3` and the desktop app. A server launched directly under Bun cannot
complete WebSocket subprotocol negotiation for this gateway and reports
Browser as unavailable; desktop snapshot review remains available.

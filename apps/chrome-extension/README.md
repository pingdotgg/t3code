# T3 Code Browser Agent

This is an unpacked Chrome extension that pairs with a T3 Code backend over bearer auth and a
browser-agent WebSocket.

Load it from `chrome://extensions` with Developer Mode enabled, choosing this
`apps/chrome-extension` directory.

The normal pairing path is automatic: click **Preview** in T3 Code. If no browser agent
is connected yet, T3 Code creates a bearer alias for the current session, opens the backend's
`/browser-agent/auto-pair` URL in the default browser, and this extension consumes that session
token before the preview command is retried. This works for owner and non-owner remote sessions.

Manual pairing is still available from the extension icon for remote browsers or debugging. Enter a
reachable T3 Code backend URL plus a pairing token from the app.

After pairing, **Preview** sends a backend command to the extension. The extension opens or focuses
the matching dev-server tab, groups it by repo name, records that tab as the active
workspace, and serves the T3 Code chat from Chrome's native side panel. If Chrome does not open the
side panel automatically, click the extension icon in the preview window.

The cursor button in T3 Code sends an annotation command through the backend. The extension focuses
the linked preview tab, lets you click an element, captures a cropped screenshot around the
highlighted element, and sends the annotation back to the backend. The backend appends the
annotation as a new chat message with the screenshot attachment.

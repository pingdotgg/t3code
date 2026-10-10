# Plugin views

A plugin with the `views` capability ships UI as views: one script, and optionally one stylesheet, per view, declared under `views` in `t3-plugin.json`. Views are plugin code running on the user's client, so they get none of the client's authority. The contract lives in [pluginViews.ts](../../packages/contracts/src/pluginViews.ts).

## Delivery and revocation

- Bytes travel only over the authenticated environment RPC (`pluginViews.readBundle`). No URL, lease or second hostname exists, so local, LAN, Tailscale and T3 Connect all reach views the same way.
- The server reads a view's files once per installation generation, then digests the whole directory again; it must still equal the consented digest. A mismatch, or a directory that can no longer be digested, serves nothing and makes the catalogue disable the installation. Later edits are found only at the catalogue's own checks (refresh, consent, enable, server start, a fresh plugin process); there is no file watcher.
- The installation generation is the revocation epoch. Disable, remove, a byte change the catalogue detects or a re-enable ends it, and the server refuses fetches and calls for an ended generation. Code already running stops only when the client tears the frame down, and fetched bytes are not recalled.
- Only a snapshot produced by the client's current session may mount a view or list it. A reconnect starts with no views, and an ended subscription withdraws them, because a stale snapshot would otherwise keep authorizing a revoked generation.
- A tab outlives its view and remounts when the view returns. The server's snapshot is empty while it loads after every restart, so removing tabs on revocation would drop them on each restart.

## Isolation

- Each view runs in a sandboxed `srcdoc` frame without `allow-same-origin`, inside a script-free wrapper frame. The view document's CSP lists exactly two scripts by SHA-256: the host bootstrap and the view.
- The browser checks those hashes against the text it parses. That is the integrity check, so hosts do not hash anything themselves and views need no secure context.
- Script text must avoid CR, NUL, `<!--`, `<script` and `</script`, because the HTML parser would change it. The server refuses such bytes instead of escaping them.
- A frame's own CSP cannot stop the frame navigating itself, so each host needs an embedding-side policy:
  - Web: the wrapper's `default-src 'none'` refuses network and `data:` navigations.
  - Desktop: the main process also vetoes view-frame navigations (`will-frame-navigate`).
  - iOS (no host yet): navigations must be decided natively from `WKFrameInfo`, and bridge messages that do not come from the main frame dropped.
- Nothing on web or desktop stops a view replacing itself with an inert `about:blank`. Hosts treat a missed ping as the view dying.
- Views inherit the app document's CSP and can only narrow it. Never widen the app CSP for views; a host page that forbids inline script or `srcdoc` frames shows a "did not start" state instead.
- Android is unsupported until its WebView passes the iOS-equivalent checks.

## Bridge

- The bridge is one MessagePort per mount, carrying JSON text messages only.
- Authority comes from the host's binding of the port (environment, installation, generation, view), never from message fields. A view's call reaches only its plugin's `view:<viewId>:<handler>` handlers, with `orchestration:operate`.
- Bounds, budgets, liveness, and cancellation on close are enforced in [viewBridge.ts](../../packages/client-runtime/src/pluginViews/viewBridge.ts).
- An iframe is not a process or CPU boundary: a view stuck in a loop can stall the client that hosts it.

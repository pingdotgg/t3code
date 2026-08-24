# Preview proxy

> For maintainers. Using T3 Code? See [docs/user](../user/).

The preview proxy lets a paired remote client (today: the mobile WebView) browse a dev server that
listens only on the environment's loopback interface, through the environment's own HTTP origin.
It reuses whatever transport already reaches the environment — LAN, Tailscale, or T3 Connect — so
the dev server never needs a public URL. This is a separate mechanism from the desktop preview
panel, which renders in an Electron `<webview>` on the client itself.

## Access model

A WebView cannot attach bearer headers to subresource requests, so access works like signed asset
URLs plus a cookie session:

1. The client calls `preview.listLocalServers` (unary sibling of
   `subscribeDiscoveredLocalServers`, both backed by the [port scanner][2]) and picks a target.
2. The client calls `preview.createProxyTicket` over the authenticated WebSocket. The server
   validates the URL against the discovered loopback servers and returns a single-use entry path
   with a two-minute expiry. Ticket claims are HMAC-signed ([`ProxyAccess`][1]) and pin the
   environment id, host, and port.
3. The WebView navigates to the entry path. The server redeems the ticket — expired, reused,
   malformed, or cross-environment tickets fail — sets an HttpOnly session cookie scoped to `/`,
   and 302-redirects into the proxied origin.
4. From then on, a global middleware ([`ProxyRoutes`][3]) proxies every request carrying a valid
   session cookie — documents, root-relative assets, fetch calls, and WebSocket upgrades (HMR) —
   to the pinned loopback port. `GET /api/preview/exit` clears the cookie.

## Why the whole origin

Dev servers assume they own their origin: `/src/main.tsx`, `/@vite/client`, and HMR sockets are
all root-relative. Rewriting HTML is fragile, so instead the session cookie claims the entire
environment origin for the browsing context that holds it.

On Android, React Native's fetch and the WebView share one cookie jar, so the middleware must not
capture the app's own traffic. Requests bypass the proxy when they present T3 credentials (an
`Authorization` header or a `wsTicket` query param) or target a reserved prefix (`/api/preview/`,
`/api/assets/`, `/.well-known/t3/`). Consequently a previewed dev server cannot itself use those
exact paths, and T3 credentials never reach it: credentialed requests are never proxied, and T3
cookies are stripped from forwarded `Cookie` headers.

## Version skew

Servers advertise the `previewProxy` capability on the environment descriptor; clients hide the
preview entry point when it is absent. The mobile picker and ticket RPCs follow the standard
capability gate (`=== true`).

## Known limits

- Web dev (Vite single-origin) is not wired for browser use of the proxy: root-relative proxied
  paths would resolve against the Vite origin, not the server. The feature targets the mobile
  WebView, which talks to the server origin directly.
- Entry tickets survive server restarts within their two-minute window (signing key is persisted,
  the redeemed-ticket set is in memory).

[1]: ../../apps/server/src/preview/ProxyAccess.ts
[2]: ../../apps/server/src/preview/PortScanner.ts
[3]: ../../apps/server/src/preview/ProxyRoutes.ts

# Desktop account connections

The desktop app owns an account identity independent of the selected local host.
`desktopAccount.mjs` is bundled alongside the server CLI and loaded only by Electron
main. Its credential store is `<Electron userData>/connect-account`; it reuses the
production OAuth token manager, managed relay client, DPoP signer, credential exchange,
and account/environment validation. One token manager coordinates refresh and logout.

Only the trusted main frame at the configured app origin can invoke account IPC.
The renderer receives discovery metadata and native transport addresses, never OAuth
credentials, environment access tokens, or private signing keys.

HTTP uses the privileged `t3-connect` scheme. The handler checks the app origin/referrer,
forwards only selected request headers, signs each upstream request, rejects redirects
and environment-identity mismatches, renews rejected credentials, and streams responses.
It does not propagate cookies. Device Hub HTTP requests use DPoP rather than forwarding
the native transport's tickets to the host.

WebSockets use an app-owned loopback gateway. A 30-second, single-use ticket binds each
upgrade to its account environment; the gateway also checks the app origin. The native
gateway obtains the upstream ticket and owns both ends of the connection. Logout,
account changes, and deregistration invalidate native routes, tickets, active requests,
and sockets. Renderer discovery removes account-specific projections and query caches.
Manual connections remain separate.

## Production-path acceptance fixture

Build the current native adapter and server before testing:

```sh
pnpm --filter t3 build:bundle
cd apps/server
pnpm exec vp test run integration/desktopConnect.integration.test.ts
```

The test starts two actual fork backends in disposable worktree-local directories.
Only external OAuth/relay behavior is simulated. It exercises the real PKCE callback,
OAuth exchange, account discovery, relay-signed cloud mint requests, DPoP exchange,
authenticated HTTP, native WebSocket gateway, filesystem browsing, and terminal
execution. It checks that a command writes only on the selected host, that revoked
credentials renew, and that desktop logout leaves host registrations linked.
The repeatable result artifact is `.t3/desktop-connect-proof.json`.

For the separate Electron UI pass, run this from the repository root:

```sh
node apps/server/integration/desktopConnectFixture.ts
```

The fixture prints a path to `launch.json`. It contains public environment configuration
and the two host workspace paths, but no owner credentials. Keep the fixture running.
Launch the built Electron binary directly with that environment, an isolated
`T3CODE_HOME`, and isolated Electron user data. `NODE_EXTRA_CA_CERTS` trusts only the
fixture's generated local CA for native requests. Do not disable TLS verification.
The fixture's HTTP sign-in page explicitly identifies itself as local test consent.
Use **Sign in as Fixture User**, then return to the desktop app.

Verify both devices appear, browse their distinct `alpha-only`/`beta-only` folders,
retain a typed draft while choosing a target folder from **Run on**, execute a command
on the selected device, reload to verify automatic rediscovery, and sign out. Check
the native HTTP-backed file/attachment and Device surfaces as available. Capture UI
evidence separately; the integration report does not claim Electron rendering coverage.
Stop the fixture with SIGINT/SIGTERM to stop only its two owned backends.

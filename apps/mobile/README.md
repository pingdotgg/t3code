# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## Direct Connect acceptance

The no-Clerk direct path requires a reachable HTTPS origin. Hosted browsers will block an
`http://` API or `ws://` socket as mixed content, so use the Tailscale HTTPS URL for both browser
and mobile pairing; the clients derive `wss://` from that origin.

1. Install Tailscale on the workstation and test device, sign both into the same tailnet, and
   enable HTTPS certificates for the tailnet.
2. From the repository root, build and start the fork server:

   ```bash
   pnpm --filter t3 build
   pnpm start -- --host 127.0.0.1 --port 3773 --no-browser
   ```

3. In another terminal, create and validate the persistent Tailscale HTTPS mapping and one-time client URL:

   ```bash
   pnpm --filter t3 start -- pair --tailscale --label "Physical device acceptance"
   ```

4. Open that HTTPS URL in the matching fork browser build, or in **T3 Code Dev** choose
   **Add environment** and scan/paste the URL. Pairing persists a bearer session; Clerk and the
   managed relay are not involved.
5. Open a thread, send a message, then disable and re-enable Wi-Fi (or background/foreground the
   app). Verify the connection returns to connected, the thread resnapshots without duplicate
   messages, and a queued mobile message drains once.

Automated protocol coverage is available from the repository root:

```bash
pnpm test:direct-connect-smoke
```

It builds the production browser app, starts the production server runtime, and verifies one-time
browser and shared mobile-runtime pairing, persisted bearer sessions, client-scoped HTTP snapshots
and mutations, involuntary socket loss, fresh-ticket reconnect through the shared `WsTransport`,
duplicate-free resnapshot, browser cookie persistence, and owner-side client-session revocation.
The Connect release smoke enforces wakeup probe-versus-replacement behavior, reconnect
subscriptions, environment removal cleanup, and outbox drain. Production acceptance rewrites a
deterministic HTTPS/WSS public shape onto the loopback server, so CI does not require external
credentials, trusted certificates, or an active tailnet.

### Physical-device checklist

Automated coverage does not replace these physical checks. Record device model, OS version, app
variant/version, server commit, network, and result; do not claim iOS or Android evidence unless
the steps were actually run.

1. **LAN pairing:** run `pnpm start -- --host 0.0.0.0 --port 3773 --no-browser`, then
   `pnpm --filter t3 start -- pair --label "LAN device"`. Scan the QR while both devices are on the
   same trusted Wi-Fi. Expect pairing, initial snapshot, mutation sync, and reconnect after toggling
   Wi-Fi. On iOS, record whether ATS permits the plain-HTTP LAN endpoint in the tested build.
2. **Tailscale HTTPS/WSS:** run `pnpm --filter t3 start -- pair --tailscale --label "Tailnet device"`.
   Expect an `https://<machine>.<tailnet>.ts.net/pair#token=...` URL, successful certificate
   validation, and `wss://` live sync. On Android, keep the Tailscale VPN active even if Android
   reports `isInternetReachable=false`; the environment must remain online.
3. **Short interruption:** background the app for less than 10 seconds and return. Expect a quick
   liveness probe with no duplicate snapshot rows and no unnecessary connection replacement.
4. **Long suspension:** background for at least 10 seconds or let the OS suspend the app. Expect the
   old connection to be replaced, a fresh WebSocket ticket, one clean resnapshot, and queued outbox
   messages to drain once.
5. **Wi-Fi loss:** disable Wi-Fi during a mutation, re-enable it, and expect reconnect plus exactly
   one applied mutation. Repeat while Tailscale remains the only route.
6. **Local removal and owner revocation:** remove the environment in the app and confirm local
   cached/outbox data is cleared. Pair again, run `pnpm --filter t3 start -- auth session list`,
   revoke that client with `pnpm --filter t3 start -- auth session revoke <session-id>`, and expect
   the device to disconnect and fail authenticated snapshot/ticket requests.

After acceptance, stop the server with `Ctrl-C`, remove the persistent Serve mapping, and revoke the
acceptance session so its bearer credential cannot be reused:

```bash
tailscale serve status
tailscale serve --https=443 off
pnpm --filter t3 start -- auth session list
pnpm --filter t3 start -- auth session revoke <session-id>
pnpm --filter t3 start -- auth pairing list
```

Revoke any still-active pairing credential shown by the final command with
`pnpm --filter t3 start -- auth pairing revoke <pairing-id>`. Do not store the printed pairing URL
or bearer token in shell history, screenshots, logs, or source control.

## EAS Builds

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview
```

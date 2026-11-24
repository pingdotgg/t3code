# T3 Connect setup

Deployment and client configuration for T3 Connect. See [T3 Connect](../internals/06_t3-connect.md) for trust boundaries and [infra/relay/README.md](../../infra/relay/README.md#deployment) for relay provisioning.

## Public application configuration

T3 Connect is disabled in a fresh clone. Copy `.env.example` to `.env` for production, or set these public identifiers in `.env` / `.env.local` (process env > `.env.local` > `.env`):

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

`CLERK_SECRET_KEY` belongs only in relay secrets, never in client config. Client and bundled-server builds embed these values at build time; EAS preview/production environments need the publishable key, JWT template, and relay URL.

## Clerk setup

### CLI OAuth application

Create a public OAuth application in Clerk (authorization code + PKCE):

1. Redirect URI: `http://127.0.0.1:34338/callback`
2. Scopes: `openid`, `profile`, `email`, `offline_access`
3. Enable **Device authorization grant** (required for headless/SSH login; Clerk enables it per account on request).
4. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to its public client ID.

### JWT template

Create a Clerk JWT template named `t3-relay` with `{ "aud": "t3-code-relay" }`. Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` on clients and `CLERK_JWT_AUDIENCE=t3-code-relay` on the relay.

### Desktop OAuth redirects

Enable Clerk's Native API, add `t3code-dev://app/` and `t3code://app/` to the SSO redirect allowlist, and add `t3code-dev://app` and `t3code://app` to `allowed_origins` via `PATCH https://api.clerk.com/v1/instance` (preserving existing entries).

### Android native sign-in redirects

In Clerk **Native applications > Allowlist for mobile SSO redirect**, allow each variant's callback:

| Variant     | Callback                                      |
| ----------- | --------------------------------------------- |
| Development | `clerk://com.t3tools.t3code.dev.callback`     |
| Preview     | `clerk://com.t3tools.t3code.preview.callback` |
| Production  | `clerk://com.t3tools.t3code.callback`         |

### Restricting sign-ups

Use Clerk's allowlist or Restricted mode for new sign-ups (an enabled empty allowlist blocks all sign-ups). Ban the account in Clerk to revoke existing sessions.

### Account deletion webhook

Under Clerk **Webhooks**, add an endpoint at `https://<relay domain>/v1/webhooks/clerk` subscribed to `user.deleted`, and set its signing secret as `CLERK_WEBHOOK_SIGNING_SECRET` on the relay. Deleting a user in Clerk then records the deletion, and the relay's five-minute cron tears down their managed tunnels and deletes their relay rows, retrying until a pass succeeds after the user's relay tokens have expired. Each deletion is a row in `relay_account_deletions`: pending while `completed_at` is null (`attempts` climbing means it keeps failing), then kept as the record of which account was deleted and when. Before restoring the relay database from a backup, export `relay_account_deletions`: the backup may predate some requests. After the restore, insert the exported rows that are missing, then set `completed_at` back to null on every row so the restored data is deleted again. Without the secret the route answers 404.

## Android FCM push setup

The relay sends Android push notifications directly via FCM HTTP v1 (no Expo Push account required):

1. Register each Android package (`com.t3tools.t3code.{dev,preview}` / `com.t3tools.t3code`) in Firebase and download `google-services.json`.
2. Pass `T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/abs/path/google-services.json` when prebuilding/building locally or as an EAS file variable (available to fingerprint generation as well).
3. Enable the FCM API and store the Firebase service-account JSON only in the relay's `FCM_SERVICE_ACCOUNT` secret (never in EAS app env or the repo). Set `APNS_ENABLED=false` for an Android-only relay stage.
4. For local smoke/watch verification without deploying a relay, use `vp run push:android:smoke` and `vp run push:android:watch` from `infra/relay`.

## Android UnifiedPush without Firebase

A build without Firebase configuration cannot register with the hosted relay. Setting `T3CODE_ANDROID_PUSH=unifiedpush` when running Expo prebuild and the Gradle build makes the app receive notifications through [UnifiedPush](https://unifiedpush.org) instead. The Notifications settings page then needs no T3 Connect sign-in. Builds without that variable keep the FCM path unchanged.

The relay is not involved. Each paired server pushes its own threads: the app registers its UnifiedPush endpoint with every server it is paired with (`unifiedPush.register`, which needs `orchestration:read`), again on each new connection, and unregisters when notifications are turned off. The server reuses the activity publisher that feeds the relay, so the same completion, approval, input and failure transitions alert, and sends the same payload the FCM path uses, plus a `source` key naming the server. The phone keeps one card per server and merges them into its single ongoing card. Registrations are kept in the server's secret store, and a `404` or `410` from the endpoint drops one. Only servers built from this fork push; an official server rejects the unknown method and the app carries on.

1. On the phone, install a UnifiedPush distributor:
   - **Sunup** (or any distributor that relays through a public Web Push service) needs nothing hosted and no private network. The app registers the distributor's Web Push keys with the endpoint, and the server encrypts every push to them (RFC 8291), so the push service sees only ciphertext.
   - **ntfy** pointed at a server you run issues no keys, so the server posts plain JSON. Titles then transit that server in plain text; keep it on a private network.
2. In the app, open Settings → Notifications and turn on Device Notifications. Allow notifications when asked. The row names the distributor once it has issued an endpoint, and the app registers it with every paired server.

If the distributor issues a new endpoint while the app is closed, the phone shows "push endpoint changed"; opening the app registers the new one. Alerts the server cannot deliver within ten minutes are dropped, and the app ignores messages older than that anyway. To test delivery with the app swiped away, run `adb shell dumpsys deviceidle force-idle` and then finish or approve a thread.

## Desktop passkeys

For a signed macOS build (`com.t3tools.t3code`):

1. Create an explicit macOS App ID with **Associated Domains** and a matching distribution provisioning profile.
2. In Clerk Native API settings, add an iOS app with the same Apple Team ID and bundle ID, and verify `https://<frontend-api>/.well-known/apple-app-site-association` includes `<TEAM_ID>.com.t3tools.t3code`.
3. Configure signing per [Apple signing and notarization](./03_release.md#apple-signing-and-notarization-macos). Local signed builds use `T3CODE_APPLE_TEAM_ID`, `T3CODE_MACOS_PROVISIONING_PROFILE`, and optionally `T3CODE_CLERK_PASSKEY_RP_DOMAINS`. Bump the build version after changing Associated Domains so macOS refreshes cached Shared Web Credentials.

Unsigned `dev:desktop` cannot exercise passkeys. For renderer HMR with passkeys, launch an installed signed build against `vp run dev:web`:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 T3CODE_PORT=13773 \
  "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"
```

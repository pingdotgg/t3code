# KBCode Fork Setup Guide

KBCode is a white-label fork of T3 Code designed for **$0/month self-hosted remote access**, **$0 iOS sideloading with push notifications**, **first-class `prime-agent` support**, and **multi-cloud agent sandboxes** (CodeSandbox, Upstash Box, and Vercel Sandbox).

## Brand & CLI Defaults

| Setting                        | Value                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| App Display Name               | `KBCode`                                                                                     |
| CLI Binary                     | `kbcode` (`t3` alias retained for upstream script compatibility)                             |
| Bundle ID / Android Package    | `com.kbcode.app` (`.dev`, `.preview`)                                                        |
| Deep Link Scheme               | `kbcode://` (`kbcode-dev://`, `kbcode-preview://`; legacy `t3code://` links remain readable) |
| Default Sandbox Idle Auto-Stop | `8` minutes (`SANDBOX_IDLE_TIMEOUT_MINUTES=8`)                                               |

Copy `.env.example` to `.env` at the repository root and configure only the sections you need.

---

## 1. $0 Remote Access (LAN, Tailscale, or Self-Hosted Relay + Clerk Free)

### Option A: Zero-Infrastructure Direct Mode (Recommended for $0)

You do **not** need a relay, Cloudflare account, or Clerk account to connect desktop, web, and mobile clients remotely:

1. Start the host server on your LAN or Tailscale tailnet:
   ```bash
   # LAN / private network:
   kbcode serve --lan

   # Or Tailscale HTTPS (requires MagicDNS + HTTPS certs enabled on your tailnet):
   kbcode serve --tailscale-serve
   ```
2. Generate a pairing QR code / `kbcode://pair` link at any time:
   ```bash
   kbcode pair
   # or over Tailscale:
   kbcode pair --tailscale
   ```
3. Scan the QR code in the KBCode mobile app or open the `kbcode://pair?...` link in desktop.

### Option B: Self-Hosted Relay + Clerk Free Tier

If you want cloud discovery and Cloudflare Tunnel endpoints:

1. Create a free [Clerk](https://clerk.com) application and configure, in the Clerk Dashboard:
   - A JWT template named `t3-relay` with `{ "aud": "t3-code-relay" }`.
   - A public OAuth application (authorization code + PKCE) with redirect URI `http://127.0.0.1:34338/callback`, scopes `openid profile email offline_access`, and the device authorization grant enabled. Its client ID is `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`.
   - Native API enabled, Android apps `com.kbcode.app`, `com.kbcode.app.dev`, and `com.kbcode.app.preview` registered, and `kbcode://app/` plus `kbcode-dev://app/` on the redirect allowlist (the `t3code` values in the Connect runbook do not apply to this fork).
   - `KBCODE_CLERK_RELYING_PARTY` set to your instance's Frontend API host for mobile builds.
2. Copy `infra/relay/.env.example` to `infra/relay/.env`, set:
   - `RELAY_PUBLIC_URL=https://relay.yourdomain.com` (or `RELAY_API_ZONE_NAME` + `RELAY_TUNNEL_ZONE_NAME`)
   - `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_AUDIENCE`
   - `APNS_ENABLED=false` (unless you have a paid Apple Developer account for APNs)
3. Set `RELAY_PUBLIC_URL`, `CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_TEMPLATE` in your root `.env` so web, desktop, mobile, and CLI builds target your relay automatically.

> Note: Upstream `infra/relay/alchemy.run.ts` provisions Cloudflare Workers + PlanetScale Postgres + Axiom. For a strictly $0 deployment with no hosted database, use Option A (Tailscale + `kbcode pair`) together with the webhook push fallback below.

---

## 2. $0 iOS Build (Xcode + SideStore / AltStore) & Push Notification Fallback

### Building & Sideloading iOS for $0 (Personal Apple ID)

Paid Apple Developer accounts ($99/yr) are required for APNs push entitlements, App Groups, and Sign in with Apple. KBCode's Expo config supports $0 Personal Team builds out of the box:

1. In your root `.env`, set:
   ```dotenv
   T3CODE_IOS_PERSONAL_TEAM=1
   T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.kbcode.app
   ```
   When `T3CODE_IOS_PERSONAL_TEAM=1`, `apps/mobile/app.config.ts` automatically strips App Groups, Share/Widget extensions, and Sign in with Apple entitlements so Xcode can sign with a free Personal Apple ID.
2. Prebuild and archive on macOS:
   ```bash
   cd apps/mobile
   EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform ios
   ```
3. Open `apps/mobile/ios/KBCode.xcworkspace` in Xcode, select your Personal Team under **Signing & Capabilities**, and build to your iPhone (or export an unsigned `.ipa` for **SideStore** / **AltStore** 7-day automatic Wi-Fi refresh).

### $0 iOS Push Alerts via `ntfy.sh` or Telegram

Because Personal Team iOS builds cannot receive Apple APNs notifications, KBCode's server ships with an opt-in `WebhookNotificationService` (`apps/server/src/notifications/WebhookNotificationService.ts`) that fires whenever:

- An agent pauses waiting for user approval or input (`waiting_for_approval` / `waiting_for_input`)
- A turn finishes or fails (`completed` / `failed`) while **no client WebSocket is actively viewing that thread**
- A cloud sandbox is auto-stopped for idleness or approaches Vercel Sandbox's 45-minute ceiling

Every thread notification embeds a clickable `kbcode://thread/<threadId>` deep link that opens the exact thread in the sideloaded KBCode iOS app or desktop app.

#### Setup with ntfy (Recommended)

1. Install the free **ntfy** app on iOS and subscribe to a private hard-to-guess topic (e.g. `kbcode-alerts-<random>`).
2. Set in root `.env`:
   ```dotenv
   NTFY_TOPIC_URL=https://ntfy.sh/kbcode-alerts-<random>
   # Optional bearer token for protected topics or self-hosted ntfy:
   NTFY_AUTH_TOKEN=
   NOTIFICATION_DEEP_LINK_SCHEME=kbcode
   ```

#### Setup with Telegram

1. Create a bot with `@BotFather` to obtain `TELEGRAM_BOT_TOKEN` and get your numeric `TELEGRAM_CHAT_ID`.
2. Set in root `.env`:
   ```dotenv
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=987654321
   ```

Both channels can be enabled simultaneously; leaving all notification env vars blank disables webhook dispatch with zero overhead.

---

## 3. First-Class `prime-agent` Setup

1. Install `prime-agent` on your host or sandbox:
   ```bash
   curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
   ```
2. Add `PRIME_API_KEY` (and optional `RLM_MAX_DEPTH=2`; set `0` to disable recursive `rlm.spawn(...)`) to `.env` or Settings → Providers → Prime Agent.
3. Enable **Prime Agent** in Settings. Use the composer popover for `/goal`, `/autonomous` (with turn/token caps), `/refine`, and `RLM_MAX_DEPTH` toggles.
4. For autonomous loops, prefer running `prime-agent` inside a **Cloud Sandbox** (below) rather than your local workstation—the composer shows a local-host warning banner whenever Prime Agent runs outside a cloud sandbox.

---

## 4. Multi-Cloud Sandboxes (CodeSandbox, Upstash Box, Vercel Sandbox)

KBCode can spawn, connect, snapshot, pause, and auto-reap remote headless KBCode servers across three sandbox providers from **Settings → Environments / Cloud Sandboxes**:

1. Set API credentials for any providers you want in `.env`:
   - **CodeSandbox**: `CODESANDBOX_API_KEY` (Nano VM tier by default)
   - **Upstash Box**: `UPSTASH_BOX_API_KEY` (small Node runtime by default)
   - **Vercel Sandbox**: `VERCEL_OIDC_TOKEN` (or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`)
2. Set provider/git secrets (`GITHUB_TOKEN`, `PRIME_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) so bootstrapped sandboxes can clone private repos and run coding agents immediately.
3. **Pre-warming & Base Snapshots** (Recommended for fast startup):
   - Spawn your first sandbox on a provider with **Save as base snapshot** enabled (or click **Snapshot** once bootstrap finishes installing Node.js, Python, git, `kbcode`, and `prime-agent`).
   - Record the returned snapshot ID in `.env`:
     ```dotenv
     SANDBOX_DEFAULT_SNAPSHOT_CODESANDBOX=<snapshot-id>
     SANDBOX_DEFAULT_SNAPSHOT_UPSTASH=<snapshot-id>
     SANDBOX_DEFAULT_SNAPSHOT_VERCEL=<snapshot-id>
     ```
   - Subsequent spawns boot directly from the pre-warmed snapshot in seconds.
4. **Idle Auto-Stop & Vercel Hobby Ceiling Guard**:
   - A 2-minute background watchdog automatically pauses/stops any sandbox with zero running turns after `SANDBOX_IDLE_TIMEOUT_MINUTES` (default `8`) and sends an optional ntfy/Telegram notification.
   - For **Vercel Sandbox** (45-minute Hobby timeout ceiling), the watchdog sends a warning alert at **40 minutes** and automatically snapshots + stops the sandbox at **43 minutes** so no work is lost.

---

## 5. Custom Brand Icons (Optional, macOS Only)

Binary icon files under `assets/{dev,nightly,prod}` are validated against Xcode Icon Composer (`ictool`) via `vp run icons:check`. To swap in custom KBCode artwork without breaking `icons:check`, edit `assets/{dev,nightly,prod}/app-icon.icon` on macOS with Icon Composer 2+ and run:

```bash
vp run icons:export
```

---

## 6. Staying Clean on Upstream Merges

Custom KBCode extensions are isolated in dedicated modules (`packages/shared/src/brand.ts`, `apps/server/src/notifications/`, `packages/provider-prime-agent/`, `packages/sandbox-providers/`, `apps/server/src/sandboxes/`) so `git merge upstream/main` stays minimal and predictable.

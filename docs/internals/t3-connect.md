# T3 Connect

> For maintainers. Using T3 Code? See [docs/user](../user/).

T3 Connect uses one Clerk application for web, desktop, and mobile authentication. The relay verifies
two kinds of bearer credential: template JWTs generated from the `t3-relay` template with the shared
`t3-code-relay` audience, and Clerk OAuth tokens issued to the CLI. `verifyRelayClientBearerToken` in
`infra/relay/src/http/Api.ts` tries the template/session path first and falls back to OAuth
verification (`acceptsToken: "oauth_token"`), so the CLI's OAuth credential works without a JWT
template.

For the wider system diagram, see
[t3-code-connect-auth-flow.html](./t3-code-connect-auth-flow.html).

## Application Keys

T3 Connect is disabled in a fresh clone. To enable it for source builds, add a repository-root `.env`
or `.env.local` file:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

The shared client loader projects these canonical values into framework-specific `VITE_*` and
`EXPO_PUBLIC_*` aliases. Existing aliases remain accepted as overrides for compatibility, but new
client configuration should use the canonical names.

Configuration precedence is:

1. Process or CI environment variables.
2. Repository-root `.env.local`.
3. Repository-root `.env`.

The Clerk publishable key, JWT template name, CLI OAuth client ID, and relay URL are public
identifiers, not secrets.
Web, desktop, mobile, and bundled server builds statically inject the values they consume during
their build step. A built artifact does not need an environment file at runtime. CI release builds
should set `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `T3CODE_RELAY_URL` before building. EAS preview and
production builds only need the Clerk publishable key, JWT template name, and relay URL in their EAS
environment.

When any client-facing public value is absent, cloud UI is omitted. The `t3 connect` command group is
always registered: when the CLI public values are absent, `makeCli` in `apps/server/src/bin.ts`
registers a hidden fallback `connect` command that reports the missing configuration instead of
silently vanishing from help. The bundled server still accepts runtime overrides for self-hosted or
operator-managed deployments.

For a hosted relay deployment, copy `infra/relay/.env.example` to `infra/relay/.env`. The relay
deployment reads `RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`,
`CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_AUDIENCE` through Effect `Config`. There are no checked-in
deployment defaults.
`vp run --filter t3code-relay deploy` invokes Alchemy from the relay directory, so Alchemy loads
`infra/relay/.env`. After a successful deployment, the wrapper updates the repository-root `.env`
with the deployed HTTPS relay URL. The relay still requires
`CLERK_SECRET_KEY` as an Alchemy secret. Never put `CLERK_SECRET_KEY` in a client application
environment or commit it to the repository.

The `prod` Alchemy stage owns the retained PlanetScale database. Non-production stages reference
that database and provision isolated PlanetScale branches, so deploy `prod` before creating a
personal developer stage.

## Headless CLI OAuth Application

The `t3 connect` commands authorize a headless environment with a separate Clerk OAuth application.
This uses an OAuth public client with PKCE, so the CLI stores no client secret.

In **Clerk Dashboard > OAuth applications**:

1. Create an OAuth application for the T3 CLI.
2. Enable the **Public** option so authorization-code exchange uses PKCE.
3. Add **both** allowed redirect URIs:
   - `http://127.0.0.1:34338/callback` for the loopback listener;
   - `https://app.t3.codes/connect/callback` for the hosted out-of-band flow. This is
     `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)` from `packages/shared/src/connectAuth.ts`, so a
     custom `T3CODE_HOSTED_APP_URL` means `$T3CODE_HOSTED_APP_URL/connect/callback` instead.
     Omitting it breaks headless and SSH authorization.
4. Enable the `openid`, `profile`, and `email` scopes.
5. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` in the repository-root `.env` file and release build
   environment to the generated public client ID.

The CLI derives Clerk's frontend API URL from the publishable key and calls Clerk's
`/oauth/authorize` and `/oauth/token` endpoints directly. The relay is not involved in the OAuth
handshake; it only validates the issued Clerk bearer token when the CLI manages an environment link.

The connect command group is:

```sh
t3 connect            # default: onboarding
t3 connect login
t3 connect link       # --publish-only
t3 connect status     # --json
t3 connect publish    # --disable
t3 connect unlink
t3 connect logout
```

`t3 serve` is a separate top-level command, not a connect subcommand.

`t3 connect login` opens the Clerk authorization flow and stores the CLI credential without enabling
cloud exposure. `t3 connect link` installs the pinned managed `cloudflared` binary when needed,
authorizes when needed, and records durable intent to expose the environment. It works without a
running T3 server. The next `t3 serve` or `t3 start` reconciles the relay link and launches the
managed tunnel. `t3 connect unlink` records disabled intent immediately, stops a reachable running
connector, and attempts to revoke the relay-side environment record. It retains the stored CLI
authorization so `t3 connect link` can re-enable exposure without another browser flow. `t3 connect
logout` performs the same cleanup and removes the stored CLI authorization.

The background service has an independent lifecycle. Connect setup may offer to install it, but
logout leaves it running; manage it with `t3 service status`, `install`, `update`, and `uninstall`.

### Headless and SSH authorization

The loopback OAuth callback listener binds to port `34338`. That path only works when a browser on
the same machine can reach it, so `authorizeCli` in `apps/server/src/cli/connect.ts` automatically
selects the out-of-band flow when `--headless` is passed or when it detects SSH through
`SSH_CONNECTION` or `SSH_TTY`. The out-of-band flow prints the hosted `/connect` authorization URL
and accepts a pasted authorization code, so no port is involved.

Port forwarding is therefore optional, not required. Forward the port only if you specifically want
the loopback flow over SSH:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

## JWT Template

In **Clerk Dashboard > JWT templates**, create a template with:

| Setting | Value                        |
| ------- | ---------------------------- |
| Name    | `t3-relay`                   |
| Claims  | `{ "aud": "t3-code-relay" }` |

Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` in the repository-root `.env`, and set
`CLERK_JWT_AUDIENCE=t3-code-relay` in `infra/relay/.env`. Define `CLERK_JWT_TEMPLATE` and
`CLERK_JWT_AUDIENCE` in the production relay deployment environment as well. The stable `aud` value
is shared by production and non-production relay stages. The client-facing `T3CODE_RELAY_URL` still
selects the concrete relay deployment, but changing that URL does not require a JWT template change.

## Desktop OAuth Redirect Allowlist

The desktop app opens OAuth in the system browser and returns to the app with a custom URL scheme.
In **Clerk Dashboard > Native applications**, enable the Native API and add these entries under the
mobile SSO redirect allowlist:

```text
t3code-dev://app/
t3code://app/
```

Local desktop development uses `t3code-dev://app`, while packaged builds use `t3code://app`. Add the
matching origin to each Clerk instance's Backend API `allowed_origins` array as well. The development
Clerk instance should only need `t3code-dev://app`; the production Clerk instance should only need
`t3code://app`. `@clerk/electron` owns the native request adapter, encrypted Clerk token persistence,
external-browser OAuth transport, and callback delivery for initial sign-in and linked-account flows.

There is currently no Dashboard UI for `allowed_origins`. Preserve any existing entries and update
the instance through the Backend API:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["t3code://app"]}'
```

Never put `CLERK_SECRET_KEY` in the desktop app, a client-facing environment file, or a build
artifact.

## Desktop Passkeys

The production macOS bundle ID is `com.t3tools.t3code`. To enable native passkeys:

1. Create an explicit macOS App ID for `com.t3tools.t3code` in the Apple Developer portal and enable
   **Associated Domains**.
2. Create a compatible macOS provisioning profile for that App ID and the certificate used to sign
   the distributed app.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID. This is
   also the configuration point for Electron/macOS passkeys.
4. Confirm Clerk serves `https://<frontend-api>/.well-known/apple-app-site-association` and that
   `webcredentials.apps` contains `<TEAM_ID>.com.t3tools.t3code`.
5. Set the local or CI signing configuration described below.

For a local signed build, add these values to `.env.local` or export them before invoking the
desktop artifact command:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile
# Optional: comma-separated override when Clerk's RP ID differs from the Frontend API hostname.
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

When `T3CODE_CLERK_PASSKEY_RP_DOMAINS` is absent, the build derives the RP domain from
`T3CODE_CLERK_PUBLISHABLE_KEY`. Signed macOS builds fail early if the Team ID, provisioning profile,
or RP-domain configuration is missing. The generated main-app entitlements include every configured
`webcredentials:<domain>` entry; helper apps keep Electron's minimal default entitlements.

The normal `dev:desktop` launcher is unsigned and cannot complete macOS passkey ceremonies. For
renderer HMR, build and install a signed app first, run the renderer dev server, then launch the
installed app executable with `VITE_DEV_SERVER_URL` and `T3CODE_PORT` set. Rebuild the signed app
after native dependency, main-process, preload, entitlement, provisioning, or signing changes;
renderer-only changes can reuse the installed app.

For the default development ports, run `pnpm dev:web` in one terminal and launch the installed
binary from another:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3CODE_PORT=13773 \
  "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"
```

After changing Associated Domains, bump the build version before rebuilding; macOS may otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/T3 Code (Alpha).app"
codesign -d --entitlements :- "/Applications/T3 Code (Alpha).app"
```

The current mobile UI uses Clerk's native authentication view. If a future mobile browser OAuth
flow uses a custom redirect URI, add that exact URI to the same allowlist.

## Sign-in Surfaces

Signed-in users manage T3 Connect under **Connections**. The settings sidebar also has dedicated
controls, rendered by `SettingsSidebarNav.tsx`: `T3ConnectSidebarSignIn` in the footer shows a
**Sign in to T3 Connect** button while signed out, and `T3ConnectSidebarAvatar` shows a Clerk
`UserButton` account control while signed in. Both are gated on cloud public configuration.
Desktop renders the same web bundle, so it has them too. The waitlist enrollment flow from the
private beta was removed when Connect went GA; sign-up is open unless a Clerk restriction below is
enabled.

## Restricting Sign-ups: Known-User Allowlist

For a closed deployment where all permitted users are known in advance, restrict sign-up to
permitted email addresses or domains:

1. In **Clerk Dashboard > Restrictions > Allowlist**, add each permitted email address or email
   domain.
2. Enable the allowlist and save.
3. Alternatively, enable **Restricted mode** when all new users must be explicitly invited or
   manually created.

Do not enable an empty allowlist: it blocks all new sign-ups.

Clerk allowlists control who can sign up. They do not revoke an existing user's active cloud
access. To remove an already-created user's access, ban that user in Clerk so their active
sessions are ended and future sign-ins are rejected.

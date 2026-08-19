# T3 Connect

> For maintainers. Using T3 Code? See [docs/user](../user/).

T3 Connect uses one Clerk application for web, desktop, and mobile authentication. The relay verifies
two kinds of bearer credential: template JWTs generated from the `t3-relay` template with the shared
`t3-code-relay` audience, and Clerk OAuth tokens issued through the headless CLI OAuth application.
`verifyRelayClientBearerToken` in `infra/relay/src/http/Api.ts` tries the template/session path first
and falls back to OAuth verification (`acceptsToken: "oauth_token"`), so the OAuth credential works
without a JWT template. The DPoP token-exchange endpoint accepts both credential kinds as
`subject_token` through the same verifier.

Only the hosted web app and mobile run Clerk in the client. The desktop app has no in-app auth UI:
its renderer talks to the bundled environment server, which runs the same browser OAuth flow as
`t3 connect login` and shares the same stored credential (see Desktop Sign-in below).

For the wider system diagram, see
[t3-code-connect-auth-flow.html](./t3-code-connect-auth-flow.html).

## Application Keys

T3 Connect is disabled in a fresh clone. To enable it for source builds against the production
deployment, copy the repository-root example file:

```sh
cp .env.example .env
```

`.env.example` carries the production public identifiers (the same values baked into official
release builds). To target a different Clerk application or relay, set the values yourself in a
repository-root `.env` or `.env.local` file:

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
6. Set the same client ID as `CLERK_CLI_OAUTH_CLIENT_ID` in the relay deployment environment. The
   relay then rejects OAuth bearer tokens minted by any other OAuth application in the Clerk
   instance; unset, any OAuth app's tokens grant relay access for their user.

Both CLI flows start at the hosted `/connect` page (`buildConnectAuthorizeRequestUrl` in
`packages/shared/src/connectAuth.ts`), which waits for a Clerk session and then forwards the request
to Clerk's `/oauth/authorize`. The CLI never opens `/oauth/authorize` directly: a signed-out browser
sent there goes through Clerk's sign-in redirect, which drops the authorize query parameters and
fails the flow with `unsupported_response_type` or an empty `state` (#5051). The loopback flow marks
the request with a `port` fragment parameter so the hosted page asks Clerk to redirect the
authorization code straight to `http://127.0.0.1:<port>/callback`; the out-of-band flow omits it and
uses the hosted `/connect/callback` page instead. The CLI derives Clerk's frontend API URL from the
publishable key and calls only the `/oauth/token` endpoint directly. The relay is not involved in
the OAuth handshake; it only validates the issued Clerk bearer token when the CLI manages an
environment link.

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

## Desktop Sign-in

The desktop app runs no Clerk and no auth UI of its own. Signing in from the desktop app calls the
bundled environment server's connect auth endpoints (`/api/connect/auth/*` in
`packages/contracts/src/environmentHttp.ts`, handled in `apps/server/src/cloud/http.ts`), and the
server runs the same loopback authorization-code + PKCE flow as `t3 connect login`
(`beginBrowserLogin` in `apps/server/src/cloud/CliTokenManager.ts`): it opens the system browser at
the hosted `/connect` page, waits on `http://127.0.0.1:34338/callback`, exchanges the code, and
persists the credential as the `cloud-cli-oauth-token` secret. The renderer watches
`/api/connect/auth/state` while the sign-in is pending and reads the access token from
`/api/connect/auth/token` for relay calls, so one stored credential serves the desktop app and the
CLI on the same T3 home in both directions. A browser that lands on the hosted out-of-band code
page instead of the loopback callback (a hosted app predating #6285 drops the loopback port through
sign-in) can be recovered without restarting: the waiting dialog accepts the displayed code through
`/api/connect/auth/code`, and the server exchanges it against the hosted callback redirect URI. Passkeys, sign-up, and account management all happen in
the browser, where they work.

The renderer-side split lives in `apps/web/src/cloud/connectAuth.tsx`: `useT3ConnectAuth` is the one
session surface, backed by `ClerkConnectAuthProvider` on the web and `DesktopConnectAuthProvider`
under Electron. Everything downstream (managed relay session, link controller, onboarding, sidebar)
consumes the hook and does not know which backend is active.

No Clerk Native API configuration, custom-scheme redirect allowlist, `allowed_origins` entry, or
macOS passkey entitlements are needed for desktop. The `t3code://` scheme only serves the renderer
inside Electron; it is not registered with the OS.

`/api/connect/auth/token` returns the raw OAuth access token to any admin-scoped session, local or
remote, with no-store headers. This is deliberate: admin sessions belong to the environment owner,
and remote admin access already implies control of the credential through link and unlink. The
sign-in state and credential are shared with the CLI on the same T3 home, and desktop sign-out
removes that shared credential (the account menu says so).

The current mobile UI uses Clerk's native authentication view. If a future mobile browser OAuth
flow uses a custom redirect URI, add that exact URI to Clerk's mobile SSO redirect allowlist.

## Sign-in Surfaces

Signed-in users manage T3 Connect under **Connections**. The settings sidebar also has dedicated
controls, rendered by `SettingsSidebarNav.tsx`: `T3ConnectSidebarSignIn` in the footer shows a
**Sign in to T3 Connect** button while signed out, and `T3ConnectSidebarAvatar` shows the account
control while signed in — Clerk's `UserButton` on the web, a plain menu over the same relay-backed
pages on desktop. Both are gated on cloud public configuration. The waitlist enrollment flow from
the private beta was removed when Connect went GA; sign-up is open unless a Clerk restriction below
is enabled.

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

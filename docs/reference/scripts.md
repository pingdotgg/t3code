# Scripts

- `vp run dev` — Starts contracts, server, and web in watch mode.
- `vp run dev:server` — Starts just the WebSocket server. The server process runs on Bun (`@effect/platform-bun` + `BunPtyAdapter`), but task running uses `vp run`.
- `vp run dev:web` — Starts just the Vite dev server for the web app.
- The dev runner uses an isolated legacy-layout directory for compatibility. An explicit `--home-dir <path>` stores state under `<path>/userdata`; production and direct server launches use the effective storage roots described in [Storage directories](../user/storage-directories.md).
- Web dev commands do not auto-open a browser. Open the one-time pairing URL printed by the server so the first browser navigation is authenticated. Set `T3CODE_NO_BROWSER=0` only when interactive auto-open is intentional.
- Pass dev-runner flags directly after the root task name, for example:
  `vp run dev --home-dir /tmp/t3code-dev`
- `vp run start` — Runs the production server (serves built web app as static files).
- `vp run build` — Builds contracts, web app, and server.
- `vp run typecheck` — Strict TypeScript checks for all packages.
- `vp run test` — Runs workspace tests.
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...` — Inspects or seeds an isolated T3 SQLite database; writes create a private backup first.
- `vp run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `vp run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `vp run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `vp run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `vp run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/prod/black-macos-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `t3code://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `vp run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Signed macOS builds also require `T3CODE_APPLE_TEAM_ID` and
  `T3CODE_MACOS_PROVISIONING_PROFILE`. The passkey RP domain is derived from
  `T3CODE_CLERK_PUBLISHABLE_KEY` unless `T3CODE_CLERK_PASSKEY_RP_DOMAINS` overrides it.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Set `T3CODE_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `13773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `T3CODE_DEV_INSTANCE`)
- Example: `T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop`

If you want full control instead of hashing, set `T3CODE_PORT_OFFSET` to a numeric offset.

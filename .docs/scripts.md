# Scripts

- `pnpm dev` — Starts the server and web development tasks in parallel through Vite Plus. Watch tasks must not wait for their dependencies to exit.
- `pnpm dev:server` — Starts just the server using Node's TypeScript execution.
- `pnpm dev:web` — Starts just the Vite dev server for the web app.
- Dev commands default `T3CODE_HOME` to `~/.t3-dev`. For self-testing, explicitly use a directory owned by the current worktree/test:
  `pnpm dev --home-dir "$PWD/.t3/dev-test" --no-browser`
- Pass dev-runner flags directly. Additional Vite Plus runner options go after `--`, for example:
  `pnpm dev --home-dir "$PWD/.t3/dev-test" --no-browser -- --log labeled`
- Keep the full stack under the dev runner: it gives both processes the selected backend HTTP/WS URLs and `VITE_DEV_SERVER_URL`. Setting the dev URL only on a separately launched backend leaves the web client's same-origin API proxy selection misconfigured.
- Default web, HTTP, and WebSocket URLs all use `127.0.0.1`, matching environment-port preview targets. Mixing `localhost` and `127.0.0.1` can break listener reachability and cookie authentication. Previously paired `localhost` browsers need a new pairing link for the IPv4 origin.
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `bun run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `bun run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `t3://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Set `T3CODE_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `13773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `T3CODE_DEV_INSTANCE`)
- Example: `T3CODE_DEV_INSTANCE=branch-a pnpm dev:desktop`

If you want full control instead of hashing, set `T3CODE_PORT_OFFSET` to a numeric offset.
Occupied ports can shift the selection; use the actual ports in the `[dev-runner]` output.

## Self-test setup diagnostics

Before consuming a pairing token, run `preview_status`, open a tab if needed, and use
`preview_preflight` with the selected environment-port target. Check both the app route and
environment descriptor. A successful preflight does not prove screenshot capture or feature behavior.

If snapshots time out, inspect page state with `preview_evaluate` to distinguish a loaded app
from a failed capture. Record capture as blocked, not passed; do not repeatedly mint pairing
tokens for a screenshot failure. After pairing, exercise the changed feature with meaningful
data and inspect console/network diagnostics. An anchor-mapping unit test does not verify
selection UI or comment submission.

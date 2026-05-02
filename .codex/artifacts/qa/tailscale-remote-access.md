# Tailscale Remote Access QA

Date: 2026-04-16
Branch: `codex/rebuild-feature-rollout`

## Environment

- Desktop dev app launched with isolated state via `T3CODE_HOME=/tmp/t3-qa-tailscale-fix-keF5gM`
- Computer Use QA executed against `ClayCode (Dev)`
- Terminal gate passed before the final manual QA rerun:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`
  - `bun run build`
  - `bun run build:desktop`

## Manual QA

### Scenario 1: Tailnet status is visible before enabling remote exposure

1. Opened the desktop app on a fresh isolated state directory.
2. Opened **Settings** → **Connections** through the desktop UI.
3. Verified a new **Tailnet access** row appeared under **Manage local backend**.
4. Verified the row rendered the live local Tailnet identity:
   - hostname: `clays-macbook-pro.tail744884.ts.net`
   - IPv4: `100.97.126.33`
5. Verified the explanatory copy told the user to enable network access to generate a Tailnet URL.

Result: pass

### Scenario 2: Enabling network access restarts into a reachable remote-exposure state

1. Toggled **Network access** on from the desktop settings page.
2. Verified the confirmation dialog appeared cleanly in the accessibility tree with a working **Restart and enable** action.
3. Confirmed the restart from the same desktop UI flow.
4. Verified the desktop process relaunched back into **Settings** → **Connections**.
5. Verified the exposure transition returned:
   - `mode: network-accessible`
   - `endpointUrl: http://192.168.86.239:13774`
   - `advertisedHost: 192.168.86.239`
6. Verified the relaunched UI rendered:
   - the reachable LAN endpoint
   - the rewritten Tailnet URL
   - working `Copy URL` and `Open URL` actions
   - the authorized local desktop client entry
7. Polled the desktop dev logs after restart and did not see the earlier backend-readiness timeout warning recur once the backend was listening on `0.0.0.0:13774`.

Result: pass

## Expected Tailnet URL

Given the live Tailnet hostname above and the returned exposure endpoint, the Tailnet URL resolves to:

- `http://clays-macbook-pro.tail744884.ts.net:13774/`

This matches the runtime rewrite covered by `ConnectionsSettings.logic.test.ts` and the browser coverage added in `SettingsPanels.browser.tsx`.

## Observations

- The new Tailnet access row is understandable before the user exposes the backend: it explains what is missing and shows the exact Tailnet identity that will be used.
- The exposure restart path now behaves cleanly in desktop dev mode:
  - the confirmation dialog is accessible through the Computer Use tree
  - the app returns to the exposed Connections state without manual console intervention
  - the Tailnet URL is visible immediately after restart
- During the restart there are brief Vite proxy `ECONNREFUSED` messages while the backend is down, which is expected during process replacement and recovered automatically once the relaunched backend started listening.

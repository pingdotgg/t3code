# Instance Lifecycle Hooks

> For maintainers. Using T3 Code? See [docs/user](../user/).

Instance hooks let a VM management solution start and stop the machine hosting a T3 server from
inside T3 Code, so the user never has to open the management app. The management solution owns two
HTTP endpoints; T3 Code calls them at the right moments.

## Configuration

Both hooks live in the server's settings (`settings.json`, schema in
[`packages/contracts/src/settings.ts`](../../packages/contracts/src/settings.ts)):

```json
{
  "startHookUrl": "https://mgmt.example.com/instances/42/start",
  "stopHookUrl": "https://mgmt.example.com/instances/42/stop"
}
```

A management solution that provisions the VM writes these when it installs T3 Code, or sets them
later through `server.updateSettings`. Both are nullable and null by default.

Clients receive the URLs inside `ServerConfig.settings` and cache the config per environment
(IndexedDB on web). That cache is what makes the start hook usable: when the instance is off, the
server is unreachable, but the client still knows the start hook URL from the last time it was
connected. The cache is only dropped when the user removes the environment.

## Start hook

Runs client-side, on the Connections settings page, when the user clicks Connect on a saved
environment whose cached settings carry a `startHookUrl`. The protocol
([`packages/contracts/src/instanceHooks.ts`](../../packages/contracts/src/instanceHooks.ts), client
in [`apps/web/src/components/settings/startHook.ts`](../../apps/web/src/components/settings/startHook.ts)):

1. `POST <startHookUrl>` with no body.
2. The endpoint answers one of:
   - `204` — the instance is already running; connect immediately.
   - `200` with `{ "poll_url": "<url>", "retry_secs": 5 }` — the instance is starting.
   - `400` with a component form (below) — the endpoint needs user input first.
3. On a form response, the client renders the components in a dialog and POSTs the resolved values
   back to the start hook URL as a JSON array (input components only, in component order). The
   response is again interpreted per step 2, so an endpoint can re-prompt with another `400`.
4. On a poll response, the client GETs `poll_url` every `retry_secs` seconds (clamped to 1–60s,
   wall-clock deadline 10 minutes) until a `204` says the instance is up. Only a plain `200` means
   "still starting"; every other status, including redirects and `304`, fails the run rather than
   being retried.
5. The normal connect flow runs.

The form response shape:

```json
{
  "button_text": "Start",
  "components": [
    { "text": "Informational copy rendered as-is." },
    {
      "type": "select",
      "title": "Size",
      "description": "Instance size to boot.",
      "defaultValue": "small",
      "values": [
        { "userTitle": "Small", "userDescription": "2 vCPU", "content": "small" },
        { "userTitle": "Large", "userDescription": "8 vCPU", "content": "large" }
      ]
    },
    {
      "type": "text",
      "title": "Region",
      "description": "Where to boot.",
      "regex": "^[a-z]{2}-[a-z]+$",
      "validationError": "Use a region id like eu-west."
    }
  ]
}
```

A select resolves to the chosen value's `content`; a text input resolves to the entered string,
validated against `regex` client-side with `validationError` shown on mismatch.

Because the browser calls the management endpoint directly, that endpoint must allow CORS for the
app origin (including the hosted app origin when connecting from `app.t3.codes`).

The start hook runs only on an explicit Connect click. The connection supervisor's automatic
retries never call it, so a stopped instance is not restarted by background reconnect attempts.

## Stop hook

Runs server-side. The Connections page shows a Stop button on connected environments whose settings
carry a `stopHookUrl`; clicking it calls the `server.runStopHook` RPC (scope
`orchestration:operate`). The server DELETEs the stop hook URL
([`apps/server/src/instanceHooks.ts`](../../apps/server/src/instanceHooks.ts)):

- `204` — the instance is stopping; the RPC reports `outcome: "stopped"`.
- `404` — the hook no longer exists. The server clears `stopHookUrl` from its settings (which
  streams to clients and removes the Stop button) and reports `outcome: "gone"`. The clear is
  compare-and-set: a hook reconfigured while the request was in flight is left alone.
- Anything else fails the RPC with one of the `ServerStopHookError` union members
  (`ServerStopHookNotConfiguredError`, `ServerStopHookInvalidUrlError`,
  `ServerStopHookRequestError`, `ServerStopHookUnexpectedStatusError`). Only `http:`/`https:` URLs
  are dialed; anything else fails as invalid without a request.

After a stop, the saved environment keeps its registration, credentials, and cached config; the
connection drops like any other server that went away, and the next Connect click runs the start
hook again.

## Surfaces

Web owns the UI today; desktop wraps web and gets both hooks with it. Mobile can dispatch
`server.runStopHook` through the shared client-runtime command but has no start-hook UI yet — the
connect gate belongs in its Connections screen when mobile picks this up.

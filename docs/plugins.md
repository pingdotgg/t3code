# Plugins

T3 plugins are full-trust local extensions packaged as a tarball with a `manifest.json` plus
optional server and web entry bundles. Users add marketplace sources, review requested
capabilities, and install plugins through Settings -> Plugins.

## Manifest

```json
{
  "id": "hello-board",
  "name": "Hello Board",
  "version": "1.0.0",
  "description": "Stores local notes.",
  "author": { "name": "T3 Tools", "url": "https://example.com" },
  "homepage": "https://example.com/hello-board",
  "license": "MIT",
  "hostApi": "^1.0.0",
  "minAppVersion": "0.0.28",
  "capabilities": ["database"],
  "entries": {
    "server": "server/index.js",
    "web": "web/index.js"
  }
}
```

- `id` must match `[a-z][a-z0-9-]{1,40}`.
- `version` is strict semver.
- `hostApi` currently targets the SDK host API version `1.0.0` and accepts `^`, `~`, or exact
  ranges.
- `entries` must include at least one of `server` or `web`; paths are relative and may not escape
  the plugin directory.
- Web-only plugins may not declare server capabilities.

## Server Entry

Server plugins default-export `definePlugin({ register })` from `@t3tools/plugin-sdk`.

```ts
import { definePlugin } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";

export default definePlugin({
  register: (hostApi) =>
    Effect.gen(function* () {
      const database = yield* hostApi.database;
      return {
        rpc: [
          {
            method: "listNotes",
            scope: "read",
            handler: () => database.execute("SELECT * FROM p_hello_board_notes"),
          },
        ],
      };
    }),
});
```

Registrations may provide `migrations`, `rpc`, `streams`, `http`, `services`, and `recover`.
RPC and stream methods declare `scope: "read" | "operate"`; the host enforces plugin auth scopes
before dispatch.

## Web Entry

Web plugins default-export `defineWebPlugin({ register })` from `@t3tools/plugin-sdk-web`.
The web context can register routes, sidebar sections, settings pages, and commands.

```ts
import { Button, defineWebPlugin } from "@t3tools/plugin-sdk-web";

export default defineWebPlugin({
  register: (ctx) => {
    ctx.registerRoute({
      path: "notes",
      component: () => <Button onClick={() => void ctx.rpc.call("listNotes")}>Load</Button>,
    });
  },
});
```

Web bundles must treat these as runtime externals: `react`, `react-dom`, `@effect/atom-react`,
`effect`, and `@t3tools/plugin-sdk-web`. Import `effect` from the bare barrel only in web bundles:
`import { Effect } from "effect"`. Do not import web-side effect subpaths such as
`effect/Effect`; browser import maps only enumerate the bare specifier. See
`packages/plugin-sdk-web/README.md`.

Tailwind utilities are emitted by scanning the host app, not separately-built plugins. Prefer
SDK-exported host UI components, host CSS variables, or plugin-local compiled CSS.

## Capabilities

- `agents`: create and operate plugin-owned agent threads.
- `vcs`: run trusted VCS operations on absolute repository or worktree paths.
- `terminals`: create and control plugin-owned terminal sessions.
- `database`: run trusted SQL through the shared database client.
- `projections.read`: read thread, turn, message, activity, and shell projections.
- `environments.read`: read environment descriptors and projected environment state.
- `secrets`: store plugin-prefixed secrets.
- `http`: register plugin HTTP routes under `/hooks/plugins/<id>`.
- `sourceControl`: use configured source-control providers.
- `textGeneration`: call host text-generation helpers.

Capabilities are full-trust grants. Consent text is shown during install, but plugins execute
locally with the capabilities they declare.

## Database

Plugin tables must be namespaced as `p_<plugin_id_with_dashes_as_underscores>_*`. The migration
gate enforces this namespace for tables, indexes, triggers, and views, and rejects migrations that
drop or alter objects outside the plugin namespace, create temp objects, or attach other databases.
Runtime SQL is not sandboxed; only migrations are gated.

## Packaging

A marketplace source is a JSON file:

```json
{
  "plugins": [
    {
      "id": "hello-board",
      "name": "Hello Board",
      "description": "Stores local notes.",
      "author": { "name": "T3 Tools" },
      "capabilities": ["database"],
      "versions": [
        {
          "version": "1.0.0",
          "tarball": "https://example.com/hello-board-1.0.0.tgz",
          "sha256": "<64 hex chars>",
          "hostApi": "^1.0.0",
          "publishedAt": "2026-07-03T00:00:00.000Z"
        }
      ]
    }
  ]
}
```

The tarball must include `manifest.json` and the entry files referenced by the manifest. The host
downloads the tarball, verifies `sha256`, extracts it into the plugin store, validates the
manifest, runs migrations, and activates the plugin.

For local development only, `T3_PLUGIN_DEV=1` enables `file://` marketplace sources and tarballs.
The in-repo fixture at `fixtures/hello-board` builds a local marketplace with:

```sh
pnpm --dir fixtures/hello-board run build
```

## Host API Versioning

The SDK exports `HOST_API_VERSION`, currently `1.0.0`. If an installed plugin's `hostApi` range is
not satisfied, the host marks it `disabled-by-host` and skips activation until a compatible version
is installed.

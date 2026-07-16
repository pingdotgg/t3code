# Building a t3code plugin

A hands-on walkthrough: from an empty directory to a plugin you can install. We build
**Worklog** — it subscribes to the host's events, records them in its own table, and
shows them on a page. Three capabilities, one server entry, one web entry.

If you want the concepts first, read the
[capabilities reference](./plugin-capabilities.md). If you want to read finished code,
the [t3code-plugins](https://github.com/ccdwyer/t3code-plugins) repo has this exact
plugin plus two others.

## Prerequisites

- Node 22+ and `pnpm`.
- A local checkout of t3code, so the SDK types resolve (the SDKs are not yet published;
  you point at the checkout's `packages/`).
- `esbuild` (dev dependency; the build script below shells out to it).

## 1. Scaffold

A plugin is just a directory. Ours:

```
worklog/
  manifest.json
  server/index.ts
  web/index.tsx
  package.json
  tsconfig.json
```

**`manifest.json`** — identity, the capabilities you are asking the user to grant, and
where your entries live:

```json
{
  "id": "worklog",
  "name": "Worklog",
  "version": "1.0.0",
  "description": "A running record of what the agent actually did.",
  "author": { "name": "Your Name" },
  "hostApi": "^1.0.0",
  "capabilities": ["events", "database"],
  "entries": { "server": "server/index.js", "web": "web/index.js" }
}
```

`id` matches `[a-z][a-z0-9-]{1,40}`. `capabilities` is the contract with the user: ask
for exactly what you use, because they see this list at install and each grant is real.

**`package.json`** — the SDKs and `effect` are only needed for _types_; the host
supplies them at runtime, so they are not runtime dependencies:

```json
{
  "name": "worklog",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node ../../scripts/build-plugin.mjs",
    "typecheck": "tsc --noEmit"
  }
}
```

**`tsconfig.json`** — point the SDK specifiers at your t3code checkout so types
resolve:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "react-jsx",
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@t3tools/plugin-sdk": ["../path/to/t3code/packages/plugin-sdk/src/index.ts"],
      "@t3tools/plugin-sdk-web": ["../path/to/t3code/packages/plugin-sdk-web/src/index.ts"]
    }
  },
  "include": ["server", "web"]
}
```

## 2. The server entry

The server entry default-exports `definePlugin({ register })`. `register` receives
`hostApi` — your capability handles — and returns a `PluginRegistration`.

```ts
// server/index.ts
import { definePlugin, type PluginRegistration } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

class WorklogError extends Error {
  readonly _tag = "WorklogError";
}
const toError = (cause: unknown): WorklogError =>
  cause instanceof Error
    ? new WorklogError(cause.message, { cause })
    : new WorklogError(String(cause));

const WATCHED = ["thread.created", "thread.deleted", "project.created"] as const;

export default definePlugin({
  register: (hostApi) =>
    Effect.gen(function* () {
      // Obtain the capability handles. These FAIL if the manifest did not declare them,
      // so asking here is also how you find out you forgot to declare one.
      const events = yield* hostApi.events;
      const database = yield* hostApi.database;

      const registration: PluginRegistration = {
        // Migrations run once, in order. Tables MUST be namespaced p_<id>_*.
        migrations: [
          {
            version: 1,
            name: "Create worklog entries",
            up: Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`
                CREATE TABLE p_worklog_entries (
                  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                  event_type TEXT NOT NULL,
                  aggregate_id TEXT NOT NULL,
                  occurred_at TEXT NOT NULL
                )
              `;
            }).pipe(Effect.mapError(toError)),
          },
        ],

        // RPC the web entry can call. scope "read" | "operate" is enforced by the host.
        rpc: [
          {
            method: "listEntries",
            scope: "read",
            handler: () =>
              database.execute(`
                SELECT id, event_type AS eventType, aggregate_id AS aggregateId,
                       occurred_at AS occurredAt
                FROM p_worklog_entries
                ORDER BY occurred_at DESC LIMIT 100
              `),
          },
        ],

        // The subscription runs FOREVER, so it lives in a service, not in register().
        // The host forks it into the plugin's scope and tears it down on disable.
        services: [
          {
            name: "record-events",
            run: (ctx) =>
              events
                .subscribe({
                  types: [...WATCHED],
                  handler: (event) =>
                    database
                      .execute(
                        `INSERT INTO p_worklog_entries (event_type, aggregate_id, occurred_at)
                         VALUES (?, ?, ?)`,
                        [event.type, event.aggregateId, event.occurredAt],
                      )
                      .pipe(
                        Effect.asVoid,
                        // A failed insert must not end the subscription — log and move on.
                        Effect.catchCause((cause) =>
                          ctx.logger.warn("could not record event", { cause: String(cause) }),
                        ),
                      ),
                })
                .pipe(Effect.mapError(toError)),
          },
        ],
      };
      return registration;
    }).pipe(Effect.mapError(toError)),
});
```

Three things worth internalizing from this:

- **Capability handles are obtained, not imported.** `yield* hostApi.events` returns
  the handle only if `events` is in the manifest; otherwise it fails. This is the
  runtime half of the consent contract.
- **Long-running work goes in a `service`.** `subscribe` never returns. If you called
  it in `register()`, activation would hang and time out. A service is the host-forked
  home for it; you write no teardown.
- **A handler that fails must not end the stream.** The host recovers per event, but
  logging the failure is what turns a silent gap into a debuggable one.

## 3. The web entry

The web entry default-exports `defineWebPlugin({ register })`. `ctx` registers UI and
gives you `ctx.rpc` to call the server.

```tsx
// web/index.tsx
import { defineWebPlugin, type PluginWebRpc } from "@t3tools/plugin-sdk-web";
import { useCallback, useEffect, useState } from "react";

interface Entry {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

// ctx.rpc.call returns `unknown` — it crossed a process boundary. Narrow it.
const isEntry = (v: unknown): v is Entry =>
  typeof v === "object" && v !== null && typeof (v as Entry).id === "string";
const parse = (v: unknown): ReadonlyArray<Entry> => (Array.isArray(v) ? v.filter(isEntry) : []);

function Worklog({ rpc }: { readonly rpc: PluginWebRpc }) {
  const [entries, setEntries] = useState<ReadonlyArray<Entry>>([]);
  const load = useCallback(async () => {
    setEntries(parse(await rpc.call("listEntries")));
  }, [rpc]);
  useEffect(() => void load(), [load]);

  if (entries.length === 0) {
    // Say WHY it might be empty — "nothing" reads like a bug otherwise.
    return <p>Nothing recorded yet. Worklog only sees events after it was installed.</p>;
  }
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.id}>
          {new Date(e.occurredAt).toLocaleString()} — {e.eventType} ({e.aggregateId})
        </li>
      ))}
    </ul>
  );
}

export default defineWebPlugin({
  register(ctx) {
    ctx.registerRoute({ path: "", component: () => <Worklog rpc={ctx.rpc} /> });
    ctx.registerSidebarSection({
      id: "worklog",
      title: "Worklog",
      render: () => <Worklog rpc={ctx.rpc} />,
    });
  },
});
```

Two rules the web bundle must follow, and why:

- **Import `effect` from the bare barrel** — `import * as Effect from "effect/Effect"`
  works on the server but _fails in the browser_, because the runtime import map only
  enumerates the bare specifier `effect`. On the web side, `import { Effect } from "effect"`.
- **Host components come from `@t3tools/plugin-sdk-web/ui`, not `.`.** The `.` entry is
  the portable SDK (`defineWebPlugin`, types); `./ui` re-exports the host's live
  components and is monorepo-only. Plain HTML elements (as above) need neither.

## 4. Build

Plugins bundle their entries with the SDKs and `effect` marked **external** — the host
serves those as shared singletons at runtime through an import map. A plugin that
bundled its own `effect` would get a second copy of every `Schema` class, and every
structural check against the host's would silently stop matching.

A minimal build script (`esbuild` per entry, then tar + sha256 + a one-plugin
marketplace file) is in
[t3code-plugins/scripts/build-plugin.mjs](https://github.com/ccdwyer/t3code-plugins/blob/main/scripts/build-plugin.mjs);
copy it. The externals that matter:

```
server:  --external:@t3tools/plugin-sdk --external:effect --external:effect/*
web:     --external:@t3tools/plugin-sdk-web --external:@t3tools/plugin-sdk-web/*
         --external:effect --external:react --external:react/* --external:react-dom --external:react-dom/*
```

The `@t3tools/plugin-sdk-web/*` line is the easy one to miss: esbuild does not imply
subpaths from a bare external, so without it a bundle importing `.../ui` would inline
the host's UI (and a second React), and nothing would fail until it ran in a browser.

```sh
pnpm run typecheck   # tsc --noEmit
pnpm run build       # -> dist/worklog-1.0.0.tgz + marketplace.json
```

The tarball contains `manifest.json` and the built entries. `marketplace.json` is a
one-plugin index the host can install from.

## 5. Install and iterate

Development uses `T3_PLUGIN_DEV=1`, which lets the host accept `file://` marketplace
sources and tarballs. Start the host with it set, then in **Settings → Plugins** add
your `dist/marketplace.json` as a source and install. The host verifies the sha256,
extracts, validates the manifest, runs your migrations, calls `register()`, and
activates.

To iterate: rebuild, then reinstall (or upgrade). `T3_PLUGIN_DEV=1` serves plugin
assets uncacheable so a reload picks up the latest build.

## Common mistakes

| Symptom                                               | Cause                                                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PluginCapabilityUnavailable` when obtaining a handle | the capability is not in `manifest.json`                                                                                                             |
| Activation hangs / times out                          | long-running work (`subscribe`, a server loop) called in `register()` instead of a `service`                                                         |
| Web bundle throws on load                             | imported an `effect/*` subpath in the web entry; use the bare `effect` barrel                                                                        |
| Web bundle ships a second React / breaks host state   | missing `@t3tools/plugin-sdk-web/*` (or `react/*`) in the build externals                                                                            |
| Migration rejected                                    | a table/index/trigger/view outside the `p_<id>_*` namespace, or an index anchored to a core table                                                    |
| Settings form never appears                           | declared `settings` but shipped no `web` entry, or used a non-renderable field (Number/Array/nested Struct)                                          |
| A whole feature is silently inert                     | a `service`/`events`/`policy`/`context` contribution registered but never reached because activation failed earlier — check the plugin's `lastError` |

## Where to go next

- The [capabilities reference](./plugin-capabilities.md) covers every capability,
  including `policy` (deny/defer approval hooks), `context` (per-turn agent
  instructions), `providers` (ship an AI provider), and the chat surface extension
  points.
- [guardrails, ollama, worklog](https://github.com/ccdwyer/t3code-plugins) — small,
  each demonstrating a capability pairing.
- [workflow-boards-plugin](https://github.com/ccdwyer/workflow-boards-plugin) — a large
  real-world plugin (46 RPC methods) if you want to see the surface used in anger.

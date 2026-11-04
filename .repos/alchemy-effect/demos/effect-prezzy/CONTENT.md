# Content plan: Shorty, from zero to production

A link shortener with live click counts, built from an empty folder. Each
chapter adds one concept, and each chapter runs the same loop, so the
viewer watches the code, the running app, the architecture and the tests
evolve together.

## The screen

| Window | What runs there |
| --- | --- |
| VS Code | The chapter's edit, typed from the real diff |
| Terminal, top pane | `alchemy dev`, started once in chapter 1 and never stopped. It hot-reloads the Worker, the Durable Object, the queue consumer and the Vite site on every save |
| Terminal, bottom pane | `pnpm test` after every change (deploy → assert → destroy against real infrastructure), plus the odd `curl` |
| Browser | The dashboard served by `alchemy dev` (`localhost`) |
| Diagram | Resources and Bindings, generated from Alchemy's state, with each Binding expandable to the grant it produced |

## The loop, every chapter

1. **Code.** Type the change in VS Code.
2. **Dev.** The top pane shows `alchemy dev` picking the change up; the
   browser (or a `curl`) shows the new behaviour straight away.
3. **Diagram.** New Resources and Bindings animate in. The new Binding
   expands to its grant (a native binding, a secret, a token scope).
   Nodes carry a `local` or `cloud` badge: under `alchemy dev`, Workers,
   Durable Objects, D1 and Queues run in local simulators, while Neon
   and Axiom have no emulator and deploy for real into the `dev_$USER`
   stage.
4. **Test.** `pnpm test` in the bottom pane deploys a full copy of the
   stack to `test_$USER` (the plan is printed), runs the assertions
   against it, and destroys it. The diagram shows the `test_$USER` copy
   appear beside `dev_$USER` and fade out when it's destroyed.

`alchemy deploy` appears twice: chapter 0 (the first deploy) and the
finale (`--stage prod`).

The diagram is generated from the state files (the demo uses
`Alchemy.localState()`, so they sit in `.alchemy/state/`), so it always
matches what's deployed. Each host resource's state already records its
bindings and the grants they produced, e.g. from the previous reference
app:

```jsonc
// .alchemy/state/Shorty/<stage>/Api.json → bindings
{ "sid": "LinkRoom", "data": { "bindings": [{ "type": "durable_object_namespace", "className": "LinkRoom" }] } }
{ "sid": "Clicks",   "data": { "bindings": [{ "type": "queue", "name": "Clicks", "queueName": "shorty-clicks-…" }] } }
```

Nodes are resources, edges are `bindings[].sid`, edge details are the
binding data, and local resources are recognisable by their `dev:` ids.

## Chapter 0: Deploy a website

```ts
// alchemy.run.ts
export default Alchemy.Stack(
  "Shorty",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const web = yield* Cloudflare.Website.Vite("Web", { rootDir: "./web" });
    return { web: web.url };
  }),
);
```

- **Deploy:** `alchemy deploy` → `+ Web` → the `workers.dev` URL.
- **Browser:** the dashboard shell: an empty list and "API offline".
- **Diagram:** `[Web]`, no bindings.
- **Concepts:** Stack, Resource, Output, stage, state.

## Chapter 1: An Effectful Worker with an API

```ts
// src/ShortyApi.ts: one value, served by the Worker and called by the UI and the tests
export class LinksGroup extends HttpApiGroup.make("links")
  .add(HttpApiEndpoint.post("create", "/links", { payload: Schema.Struct({ url: Schema.String }), success: Link }))
  .add(HttpApiEndpoint.get("list", "/links", { success: Schema.Array(Link) }))
  .add(HttpApiEndpoint.get("get", "/links/:code", { params: Code, success: Link, error: LinkNotFound })) {}
export class ShortyApi extends HttpApi.make("ShortyApi").add(LinksGroup) {}
```

```ts
// src/Api.ts
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Construction phase: runs at deploy time and at cold start
    const links = new Map<string, Link>(); // per isolate, on purpose; chapter 2 fixes it
    const handlers = HttpApiBuilder.group(ShortyApi, "links", (h) =>
      h.handle("create", ({ payload }) => /* … */)
       .handle("list", () => Effect.succeed([...links.values()]))
       .handle("get", ({ params }) => /* … or LinkNotFound */));
    return {
      // Runtime phase: runs per request
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(ShortyApi).pipe(
          Layer.provide(handlers), Layer.provide(Http.Platform), Layer.provide(HttpRouter.cors()),
        ),
      ),
    };
  }),
) {}
```

```diff
  // alchemy.run.ts
+ const api = yield* Api;
  const web = yield* Cloudflare.Website.Vite("Web", {
    rootDir: "./web",
+   env: { VITE_API_URL: api.url },   // an Output flowing into the build
  });
```

```ts
// web/src/client.ts: typed client from the same value, no codegen
export const client = HttpApiClient.make(ShortyApi, { baseUrl: import.meta.env.VITE_API_URL });
```

- **Dev:** start `alchemy dev` in the top pane; it stays up for the rest
  of the talk. Create a link in the browser at `localhost`.
- **Diagram:** `Web ──VITE_API_URL──▶ Api` (a reference, not a binding).
- **Slide:** Construction vs Runtime phase.

## Chapter 2: Store links in D1

```sql
-- migrations/0001_links.sql (runs on SQLite now and on Postgres in chapter 6)
CREATE TABLE links (code TEXT PRIMARY KEY, url TEXT NOT NULL, created_at BIGINT NOT NULL);
```

```ts
// src/Db.ts
export const Db = Cloudflare.D1.Database("Db", { migrations: "./migrations" });
```

```diff
  Effect.gen(function* () {
+   const d1 = yield* Cloudflare.D1.QueryDatabase(Db);  // the Binding
+   const sql = yield* SQL.D1(d1);                       // Effect SQL on top
    const handlers = HttpApiBuilder.group(ShortyApi, "links", (h) =>
      h.handle("create", ({ payload }) =>
+       sql<Link>`INSERT INTO links (code, url, created_at)
+                 VALUES (${newCode()}, ${payload.url}, ${Date.now()}) RETURNING *`.pipe(/* … */))
      /* list, get */);
+   // GET /:code → 302
- }),
+ }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
```

- **Dev:** the top pane applies `0001_links.sql` to the local D1; links
  now survive reloads; `curl -I localhost:1337/<code>` shows the `302`.
- **Diagram:** `Api ──d1──▶ Db [local]`. The grant: `{ type: "d1", name: "Db" }`,
  this one database and no account token.

## Chapter 3: Test it against the real cloud

```ts
// test/api.test.ts
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
});
const stack = beforeAll(deploy(Stack));   // a full copy in stage test_$USER
afterAll(destroy(Stack));                 // gone again afterwards

test("create, get, redirect", Effect.gen(function* () {
  const { api } = yield* stack;
  const client = yield* HttpApiClient.make(ShortyApi, { baseUrl: api }); // the same typed client
  const link = yield* client.links.create({ payload: { url: "https://effect.website" } });
  expect((yield* client.links.get({ params: { code: link.code } })).url).toBe("https://effect.website");
  const missing = yield* client.links.get({ params: { code: "nope" } }).pipe(Effect.flip);
  expect(missing._tag).toBe("LinkNotFound"); // a typed error, across HTTP
}));
```

- **Test:** `pnpm test`: the plan for `test_sam` (`+ Db`, `+ Api`, `+ Web`),
  the apply, the green assertions, the destroy. From here on every
  chapter ends with `pnpm test`.
- **Diagram:** a `test_sam` copy appears beside `dev_sam`, all nodes
  `cloud`, and fades out on destroy.
- **Point:** `alchemy dev` is for trying it; `pnpm test` proves it on
  the real infrastructure.

## Chapter 4: Durable Objects and hibernatable WebSockets

```ts
// src/LinkRoom.ts: one instance per link
export default class LinkRoom extends Cloudflare.DurableObject<LinkRoom>()(
  "LinkRoom",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      let clicks = (yield* state.storage.get<number>("clicks")) ?? 0;
      return {
        record: Effect.fn(function* (n: number) {
          clicks += n;
          yield* state.storage.put("clicks", clicks);
          for (const ws of yield* state.getWebSockets()) yield* ws.send(JSON.stringify({ clicks }));
          return clicks;
        }),
        fetch: Effect.gen(function* () {           // hibernatable: sockets outlive eviction
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* socket.send(JSON.stringify({ clicks }));
          return response;
        }),
      };
    });
  }),
) {}
```

```diff
+ const rooms = yield* LinkRoom;
  // GET /:code
+ yield* rooms.getByName(link.code).record(1);         // typed RPC, no schema
  // GET /links/:code/live
+ return yield* rooms.getByName(code).fetch(request);  // hand the socket to the room
```

```ts
// web: a live counter per row
new WebSocket(`${WS_URL}/links/${code}/live`).onmessage = (e) => setClicks(JSON.parse(e.data).clicks);

// test: a click is pushed to an open socket
test("clicks are pushed live", Effect.gen(function* () {
  // open ws → GET /:code → the next message is { clicks: 1 }
}));
```

- **Dev:** the browser counter ticks as the short link is opened in
  another tab.
- **Diagram:** `Api ──durable_object_namespace──▶ LinkRoom ×N`, plus
  `Browser ⇄ LinkRoom` (WebSocket). The grant: the namespace binding
  and its class migration.

## Chapter 5: A Queue, so redirects stay fast

```ts
export const Clicks = Cloudflare.Queues.Queue("Clicks");
```

```diff
+ const clicks = yield* Cloudflare.Queues.WriteQueue(Clicks);
+ yield* Cloudflare.Queues.consumeQueueMessages<ClickEvent>(Clicks,
+   { batchSize: 100, maxWaitTime: "1 second", retryDelay: "3 seconds" },
+   (events) => events.pipe(
+     Stream.runFold(() => new Map<string, number>(),
+       (counts, { body }) => counts.set(body.code, (counts.get(body.code) ?? 0) + 1)),
+     Effect.flatMap((counts) => Effect.forEach(counts,
+       ([code, n]) => rooms.getByName(code).record(n),
+       { concurrency: "unbounded", discard: true }))));
  // GET /:code
- yield* rooms.getByName(link.code).record(1);
+ yield* clicks.send({ code: link.code, at: Date.now() });   // off the hot path
```

- **Dev:** the local broker batches; the top pane logs each batch; the
  browser counter jumps by batch.
- **Diagram:** `Api ──queue──▶ Clicks ──consumer──▶ Api ──▶ LinkRoom`, a
  cycle Alchemy resolves. Grants: the producer binding and the
  `Consumer` resource.
- **Test:** ten `GET /:code` → poll until `clicks` is 10.
- **Aside:** `retryDelay` covers batches delivered while a fresh deploy
  is still rolling out (found while building #1781).

## Chapter 6: Storage as a Layer, with Neon as the alternative

```ts
// src/Links.ts: the contract the Worker depends on
export class Links extends Context.Service<Links, {
  create(url: string): Effect.Effect<Link, LinkStoreError, Alchemy.RuntimeContext>;
  get(code: string): Effect.Effect<Link, LinkNotFound | LinkStoreError, Alchemy.RuntimeContext>;
  list(): Effect.Effect<Link[], LinkStoreError, Alchemy.RuntimeContext>;
}>()("Links") {}

// one implementation, written against Effect's generic SqlClient
export const LinksSql = Layer.effect(Links, Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insert = SqlSchema.single({ Request: NewLink, Result: Link,
    execute: (l) => sql`INSERT INTO links ${sql.insert(l)} RETURNING *` });
  return { create: (url) => insert({ code: newCode(), url, created_at: Date.now() }), /* … */ };
}));
```

```ts
// src/Storage.ts: each storage Layer owns its infrastructure
export const D1Storage = Layer.unwrap(Effect.gen(function* () {
  return SQL.D1Layer(yield* Cloudflare.D1.QueryDatabase(Db));
})).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));

export const NeonStorage = Layer.unwrap(Effect.gen(function* () {
  const db = yield* Neon.Project("Postgres", { migrations: "./migrations" }); // same SQL files
  const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", {
    origin: db.origin,            // deployed: Hyperdrive pools Neon's direct endpoint
    dev: db.pooledOrigin,         // alchemy dev: straight to Neon's own pooler
    caching: { disabled: true },  // links must be read-after-write
  });
  const conn = yield* Cloudflare.Hyperdrive.Connect(pool);
  return Postgres.PostgresLayer({ url: conn.connectionString });
})).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
```

```diff
  // src/Api.ts
- }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
+ }).pipe(Effect.provide(LinksSql.pipe(Layer.provide(NeonStorage)))),
  // alchemy.run.ts
- providers: Cloudflare.providers(),
+ providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
```

- **Dev:** the top pane creates a real Neon project and branch in
  `dev_sam` (no Neon emulator) and applies the migration; the local
  Worker talks to it. The browser behaves exactly as before.
- **Diagram:** `Api ──hyperdrive──▶ Pool ──▶ Neon Main [cloud] ◀── Db [cloud]`,
  `Db [local D1]` removed. Grant: the Hyperdrive binding, with the
  connection string delivered as a secret and never in plan output.
- **Test:** the chapter 3–5 suite, unchanged, passes on Neon. The
  unchanged tests are the proof that the swap is behaviour-preserving.
- **Note:** `SqlSchema` decodes rows through `Link`, so D1's numbers and
  Postgres's `bigint` for `created_at` both decode to the same type.

## Chapter 7: OpenTelemetry to Axiom

```ts
// src/Observability.ts: names include the stage so dev, test and prod never collide
export const Observability = Effect.gen(function* () {
  const { stage } = yield* Stack;
  const traces = yield* Axiom.Dataset("Traces", { name: `shorty-${stage}-traces`, kind: "otel:traces:v1" });
  const logs = yield* Axiom.Dataset("Logs", { name: `shorty-${stage}-logs`, kind: "otel:logs:v1" });
  const ingest = yield* Axiom.ApiToken("Ingest", {
    name: `shorty-${stage}-ingest`,
    datasetCapabilities: {                   // can write these two datasets and nothing else
      [traces.name]: { ingest: ["create"] },
      [logs.name]: { ingest: ["create"] },
    },
  });
  return { traces, logs, ingest };
});
```

```ts
// the exporter is a Layer built from those resources
export const Telemetry = Layer.unwrap(Effect.gen(function* () {
  const { traces, logs, ingest } = yield* Observability;
  return Axiom.Telemetry({ token: ingest, traces, logs });
}));
```

```diff
  }).pipe(Effect.provide(Layer.mergeAll(
    LinksSql.pipe(Layer.provide(NeonStorage)),
+   Telemetry,
  ))),

  // spans come from code that is already Effect
- create: (url) => insert(/* … */),
+ create: Effect.fn("links.create")(function* (url) { /* … */ }),
```

- **Dev:** click around in the browser, then open Axiom's trace view:
  `GET /:code` → `links.get` → SQL → queue send, and separately the
  consumer → `LinkRoom.record`.
- **Diagram:** `Api ──otlp──▶ Traces, Logs [cloud]`, `Ingest` as a
  secret binding. Grant: the token's `datasetCapabilities`.
- **Test:** optional: query Axiom until the test's own request span
  arrives.

## Chapter 8: A dashboard as code

```ts
yield* Axiom.Dashboard("Shorty", {
  dashboard: {
    name: `Shorty (${stage})`, owner: "", schemaVersion: 2, refreshTime: 15,
    timeWindowStart: "qr-now-30m", timeWindowEnd: "qr-now",
    charts: [
      { id: "rps", name: "Requests / route", type: "TimeSeries",
        query: { apl: `['${traces.name}'] | where kind == 'server' | summarize count() by bin_auto(_time), name` } },
      { id: "p95", name: "p95 latency", type: "Statistic",
        query: { apl: `['${traces.name}'] | summarize percentile(duration, 95)` } },
      { id: "clicks", name: "Clicks / link", type: "Table",
        query: { apl: `['${traces.name}'] | where name == 'LinkRoom.record' | summarize sum(toint(['attributes.n'])) by tostring(['attributes.code'])` } },
      { id: "errors", name: "Errors", type: "TimeSeries",
        query: { apl: `['${traces.name}'] | where error == true | summarize count() by bin_auto(_time)` } },
    ],
    layout: [/* 2 × 2 grid */],
  },
});
```

- **Dev:** a small load loop in the bottom pane; the Axiom dashboard
  fills in live in the browser.
- **Diagram:** `Shorty dashboard ──reads──▶ Traces`: the architecture now
  includes how the service is observed.

## Finale: production

```sh
alchemy deploy --stage prod
```

The whole diagram, panned back through each chapter's version, then the
`prod` copy appearing beside `dev_sam`: the same program, a second
complete environment. `alchemy destroy` runs off camera.

## Build status

All nine chapters are built in `chapters/` (see its README). Each one
type-checks and was run under `alchemy dev`; chapters 3–8 pass
`pnpm test` against the `testing` account (deploy, assert, destroy in
17–62 s). Things learned while building:

- Hyperdrive caches query results by default, so a link created and
  then listed came back missing. Chapter 6 turns caching off; that is a
  good on-camera aside.
- `created_at` is ISO text so the same migration and queries run on D1
  and Postgres.
- Axiom accepts stage names like `dev_samgoodwin` in dataset names, and
  telemetry exports from a local Worker under `alchemy dev`.
- `Axiom.Dataset.name` is a deploy-time Output, so the dashboard builds
  its query strings from the stage instead.
- The dashboard's dev port is pinned (`dev: { port: 5173 }`) so the API
  always lands on `localhost:1337`.
- Right after a fresh deploy, requests and queue batches can briefly hit
  the placeholder Worker. Tests retry cold-start responses
  (`Test.executeWhenReady`), and the consumer uses `maxRetries: 10` with
  `retryDelay: "3 seconds"` so no click is dropped.

## Tooling this plan needs

- The diagram renderer (Remotion, auto layout, `local`/`cloud` badges,
  expandable grants), driven by the state files after each save.
- A terminal window with two panes (tmux): `alchemy dev` on top, tests
  below.
- Live browser recording (WebSocket counters, Axiom charts).
- `pnpm test` output captured in the terminal clip.
- One saved code checkpoint per chapter, each of which type-checks,
  runs under `alchemy dev` and passes `pnpm test`.

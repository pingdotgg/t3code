# Foldkit frontends

Foldkit is event-driven like the domain. The app's Commands send domain commands, its Subscriptions turn live view reads into Messages, and `update` folds Messages into the Model. The domain package's Api gives the browser a typed client: no hand-written fetch code, no duplicated schemas.

## The Api client as a resource

Build the client once, for the app's life, and give it to Foldkit as a resource. Sign in first, so the browser carries an `HttpOnly`, `SameSite=Strict` session cookie on the same origin, including on every WebSocket upgrade.

```ts
// packages/web/src/entry.ts
import { CustomerApi } from "@acme/domain/CustomerApi.api";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { Flags, init, Model, subscriptions, update, view } from "./Bank.ts";

const BankConnection = Layer.unwrap(
  Effect.gen(function* () {
    yield* signIn;   // POST /api/session
    return CustomerApi.layerClient.pipe(
      Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

Runtime.run(
  Runtime.makeApplication({
    Model, Flags, init, update, view, subscriptions,
    resources: BankConnection,
    container: document.getElementById("root"),
  }),
  { flags: Effect.succeed({ /* ... */ }) },
);
```

More: [Integrate with Foldkit: Provide the client and headers](https://alchemy.run/domain/foldkit#provide-the-client-and-headers).

## Derive the Commands

Use the optional `@alchemy.run/domain/Foldkit` subpath with Foldkit 0.169 or later.

```ts
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { Command, Subscription } from "foldkit";
import * as Option from "effect/Option";

const BankClient = DomainFoldkit.make(CustomerApi);

const send = BankClient.DepositMoney({
  target: model.accountId,
  input: { amount: 1_000 },
  commandId: allocation.commandId,
});
const command = Command.mapMessage(send, (result) => Message.ReceivedBankResult({ result }));
```

Allocate ids with `DomainFoldkit.next(model.commandIds)` and store the returned state with `modifyFields`. Declare `ReceivedBankResult` with `{ result: BankClient.Message }`. Match the result through `BankClient.Message.match`: `SucceededDepositMoney` carries the reply and receipt; `FailedDepositMoney` carries `Rejected`, `Denied`, or `Unknown`. Preserve Rejection and middleware error fields. Retry `Unknown` with the original id because the write may have committed. Command defects also produce `Unknown`.

More: [Integrate with Foldkit: Derive the Commands](https://alchemy.run/domain/foldkit#derive-the-commands), [Send a command from update](https://alchemy.run/domain/foldkit#send-a-command-from-update).

## Follow a View's state

```ts
const subscriptions = Subscription.make<Model, Message, Bank>()(() => ({
  summary: BankClient.AccountSummary.watch({
    key: (model: Model) => model.accountId,
    isEnabled: (model) => model.online,
    toMessage: ({ state, cursor }): Message => Message.ReceivedBalance({
      balance: Option.map(state, (summary) => summary.balance),
      cursor,
    }),
    onFailure: (error): Message => Message.FailedWatchSummary({ reason: error._tag }),
    onDefect: (): Message => Message.FailedWatchSummary({ reason: "Read defect" }),
  }),
  statement: BankClient.Statement.events({
    key: (model: Model) => model.accountId,
    cursor: (model) => model.statementCursor,
    isEnabled: (model) => model.online,
    onEntry: ({ event, envelope }): Message => Message.ReceivedLine({
      commandId: envelope.commandId,
      line: event,
      cursor: envelope.seq,
    }),
    onCaughtUp: (cursor): Message => Message.CaughtUpStatement({ cursor }),
    onFailure: (error): Message => Message.FailedReadStatement({ reason: error._tag }),
    onDefect: (): Message => Message.FailedReadStatement({ reason: "Read defect" }),
  }),
}));
```

Store absent state and the event cursor with `Option`. Apply each line and its cursor in one update. Cursor changes do not restart the feed. `onFailure` handles typed read failures; `onDefect` receives unexpected read Causes. Interruption ends the read without a Message. Mark the feed live after `CaughtUpStatement`.

Decode snapshot Flags with `BankClient.AccountSummary.decodeSnapshotFlags`. Use `watch` for current state and `events` for output entries and command confirmation.

More: [Integrate with Foldkit: Follow a View's state](https://alchemy.run/domain/foldkit#follow-a-views-state), [Seed the first paint](https://alchemy.run/domain/foldkit#seed-the-first-paint), [Optimistic updates: Resume the feed](https://alchemy.run/domain/optimistic-updates#resume-the-feed).

## Tracing from the browser

Foldkit wraps every Command in a span, and Api calls carry the trace to the server (live reads too). Put a tracer in `resources` that exports to the app's own origin, and collect it in the server Worker with `Telemetry.relay`, which forwards it with the server's credentials:

```ts
// packages/web/src/entry.ts
const Tracing = OtlpTracer.layer({
  url: `${location.origin}/api/telemetry/v1/traces`,
  resource: { serviceName: "bank-web" },
}).pipe(Layer.provide(OtlpSerialization.layerJson));
const Resources = Layer.mergeAll(BankConnection, Tracing).pipe(Layer.provide(FetchHttpClient.layer));

// packages/server/src/BankWorker.ts
import * as Telemetry from "alchemy/Telemetry";
const telemetry = Telemetry.relay({
  authorize: Effect.map(HttpServerRequest, (r) => Option.isSome(actorOf(r.headers))),   // signed-in only
  // route: (signal, configured) => Effect.succeed(configured),                       // choose destinations
});
if (path.startsWith("/api/telemetry/")) return yield* telemetry;
```

Never put an ingest token in the browser. Workers Observability can't receive browser spans, so relay them to an OTLP destination (Axiom, a collector).

More: [Observability: Trace the browser](https://alchemy.run/domain/observability#trace-the-browser).

## Optimistic updates and offline

- **Optimistic UI.** Send each command with a `commandId` the app chooses, and show it as pending. The view event carrying that `commandId` confirms it, and a typed rejection marks it rejected. Show the server's balance plus every unacknowledged line, so nothing is ever rolled back.
- **Offline intents.** Record what the user asked for, never facts the server owns. Queue unreachable sends in order and persist them to `localStorage`. Deliver them when back online, deduplicated by `commandId`. A conflict is just a typed rejection.

- **Predicted outcome.** `MyAggregate.predict(state, command, { id, now, context })` runs the aggregate's own `decide` and `evolve`: `Accepted` (events, envelopes, next state), `Rejected` (the same rejection the server returns), or `Unpredictable` (only the server can tell: `decide` suspended, died, or broke its declaration). `MyView.evolve(state, { name, event, source, envelope })` folds a predicted event like the server's view. `context` is required, by type, for whatever the command's middleware provides: build it from a client-side Layer of the same services (`yield* Layer.build(ClientSession)`). Still confirm from the stream.

A local mirror of server aggregates, or local-authority sync, isn't supported. It needs a sync engine or CRDTs.

More: [Optimistic updates](https://alchemy.run/domain/optimistic-updates), [Offline and local first](https://alchemy.run/domain/local-first).

## Hosting the app

`Cloudflare.Website.Foldkit` builds the app with Vite and serves it from its own Worker. That Worker forwards `/api` to the server over a service binding, so the app and the Api share one origin:

```ts
// packages/web/src/worker.ts
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BANK: Fetcher }) {
    return new URL(request.url).pathname.startsWith("/api") ? env.BANK.fetch(request) : env.ASSETS.fetch(request);
  },
};
```

More: [Integrate with Foldkit: Test and host the app](https://alchemy.run/domain/foldkit#test-and-host-the-app).

## Testing the app

Test `update` and the Commands with Foldkit stories (`foldkit/story`) in `packages/web/test`. They need no server.

More: [Integrate with Foldkit: Test and host the app](https://alchemy.run/domain/foldkit#test-and-host-the-app).

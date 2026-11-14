# Hosting on Cloudflare with alchemy

The server package hosts the model in a Cloudflare Worker. `DomainCloudflare.layerDurableObjects()` declares one Durable Object class per aggregate, view, policy, projection and stream while the Worker builds. It also runs sagas on `Cloudflare.Workflows.layerDurableObjectEngine()`. Each aggregate instance is one Durable Object: one writer, which commits its events, state, idempotency receipt and outbox in a single transaction.

```ts
// packages/server/src/BankWorker.ts
import { Bank, BankHandlers } from "@acme/domain/Bank.model";
import { CustomerApi } from "@acme/domain/CustomerApi.api";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { SiftFraudCheck } from "./Fraud/SiftFraudCheck.ts";
import { D1LedgerStore } from "./Ledger/D1LedgerStore.ts";
import { MfaChallengeLive } from "./MfaChallenge.ts";
import { SessionLive, sessionRoute } from "./Session.ts";

/** One Layer: the middleware, the hosted model, and every adapter it needs. */
const BankLive = Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(
  Layer.provideMerge(Bank.layer(BankHandlers)),
  Layer.provideMerge(D1LedgerStore),
  Layer.provide(
    Layer.mergeAll(DomainCloudflare.layerDurableObjects(), SiftFraudCheck, Cloudflare.D1.QueryDatabaseBinding),
  ),
);

export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
  "BankWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const customerApi = yield* CustomerApi;   // resolve once, at init
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/api/session") return yield* sessionRoute;
        if (path.startsWith("/api")) return yield* customerApi.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(BankLive)),   // provide one Layer, once
) {}
```

- Swap `DomainCloudflare.layerDurableObjects()` for `Domain.InMemory` and nothing else changes. That's how the Api tests host the model.
- Resources the adapters need, like a D1 database, are declared in the server package and bound through alchemy bindings (`Cloudflare.D1.QueryDatabase(db)` inside the adapter's Layer).
- Webhooks and event sources, like a Stripe webhook, are yielded in the Worker's init and send commands into the model.
- `alchemy dev` runs everything locally in workerd: Durable Objects, sagas and the foldkit app.

## Calling the Api in process

Code in the Worker that is not a client of the Api (a webhook route, a scheduled job) calls it with `CustomerApi.clientInProcess`: the same typed client, wired to the handlers in process, with the middleware of everything it serves. When that code has already checked its caller (a webhook signature), it provides a middleware Layer that trusts the caller, to that client only:

```ts
const asSystem = Layer.succeed(Session, (effect) =>
  Effect.provideService(effect, CurrentActor, system("payments-webhook")),
);
const bank = yield* CustomerApi.clientInProcess.pipe(Effect.provide(asSystem));   // per request, in Effect.scoped
yield* bank.DepositMoney(accountId, { amount });
```

- Build `clientInProcess` per request in a Worker. `layerClientInProcess` provides `CustomerApi.Client` in process, for long-lived processes and scripts.
- Do not send a request to the Worker's own URL, and do not pass a verified secret through a header to `clientInProcess` to be checked again.

More: [Api: Call it in process](https://alchemy.run/domain/api#call-it-in-process), [In memory](https://alchemy.run/domain/in-memory).

## Live reads

Clients that `watch` or read `events` open a WebSocket per read, with `Domain.protocolWebSocket`. The Worker runs the read's middleware, then hands the socket to the Durable Object that owns the key. That object pushes each committed change, judged by `validate` again, and hibernates in between. Commands go over HTTP.

More: [Cloudflare: Watch without polling](https://alchemy.run/domain/cloudflare#watch-without-polling).

## Plain HTTP and OpenAPI

For clients that are not Effect (a partner, a script, a public API), `toHttpApi` from `@alchemy.run/domain/Http` publishes an Api as an Effect `HttpApi` group, with its handlers Layer and an OpenAPI document from the same Api.

```ts
import * as DomainHttp from "@alchemy.run/domain/Http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

// every call the Api serves; a typed failure answers at its `httpApiStatus`, else 422
const BankHttp = DomainHttp.toHttpApi(CustomerApi);

// in the Worker's init, inside `.pipe(Effect.provide(BankLive))`
return {
  fetch: HttpApiBuilder.layer(BankHttp.api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(BankHttp.layer),
    Layer.provide([HttpPlatform.layer, Etag.layer]),
    HttpRouter.toHttpEffect,
  ),
};
```

A command is a `POST` with the RPC payload as its JSON body, and answers with its receipt:

```sh
curl -X POST /DepositMoney -H "cookie: $SESSION" \
  -d '{ "target": "a-1", "commandId": "d-1", "input": { "amount": 1000 } }'
# { "reply": { "balance": 1000 }, "stream": "Account/a-1", "version": 3 }
```

A read is a `GET` by key, and the receipt's `stream` and `version` make it wait for your own write:

```sh
curl "/AccountSummary/a-1?stream=Account/a-1&version=3"
curl "/AccountSummary/a-1/snapshot"
curl "/AccountSummary/a-1/list?order=desc&take=20&after=118"
```

`watch` and `events` answer with Server-Sent Events, one value per event:

```ts
const summary = new EventSource(`/AccountSummary/${accountId}/events?after=${cursor}`);
summary.onmessage = (event) => render(JSON.parse(event.data));
```

Every call runs through the Api's own handlers with the request's headers, so a rejection answers with the status its schema declares (422 if none):

```ts
export class NotOwner extends Domain.Rejection("NotOwner", {}, { httpApiStatus: 403 }) {}
// GET /AccountSummary/a-2 as someone else -> 403 { "_tag": "NotOwner" }
```

What the Api serves is what is published, so HTTP clients get their own Api:

```ts
export class PartnerApi extends Domain.Api("PartnerApi", {
  model: Bank,
  commands: ["DepositMoney"],
  views: ["AccountSummary"],
  streams: [],
  aggregates: [],
}) {}
const PartnerHttp = DomainHttp.toHttpApi(PartnerApi);
```

To serve the group next to others or under a prefix, add it to your own `HttpApi`:

```ts
const AppApi = HttpApi.make("App").add(BankHttp.group.prefix("/v1"));
const AppLive = HttpApiBuilder.layer(AppApi).pipe(Layer.provide(BankHttp.layerFor(AppApi)));
```

More: [Plain HTTP and OpenAPI](https://alchemy.run/domain/http-api).

## MCP

`toMcp` from `@alchemy.run/domain/Ai` serves each call of an Api that returns once as an MCP tool, named `<api>_<name>_<operation>`:

```ts
import * as DomainAi from "@alchemy.run/domain/Ai";
import { McpProtocol, McpServer } from "effect/ai";

// packages/server/src/BankMcp.ts
export const BankMcp = DomainAi.toMcp(AgentApi).pipe(
  Layer.provide(
    McpServer.layerHttp({ name: "bank", version: "1.0.0", path: "/mcp", protocols: [McpProtocol.v2025_11_25] }),
  ),
  Layer.provide(BankLive),
);
```

On a Worker, use `McpServer.layerHttpRequestScoped` with `McpProtocol.v2026_07_28`. Each call carries the MCP request's headers to the Api's middleware, so an MCP client signs in like any other client, and a rejection comes back as the tool's typed failure.

`toToolkit` gives the same tools to an agent in the app, acting for the headers you give it:

```ts
const { toolkit, layer } = DomainAi.toToolkit(AgentApi, {
  headers: Effect.map(CurrentSession, (s) => ({ authorization: `Bearer ${s.token}` })),
});
const answer = LanguageModel.generateText({ prompt, toolkit }).pipe(Effect.provide(layer));
```

More: [MCP](https://alchemy.run/domain/mcp).

## CLI

`toCli` from `@alchemy.run/domain/Cli` builds an Effect CLI command that calls the deployed Api over HTTP, one kebab-case subcommand per command, view, stream or aggregate:

```ts
// packages/cli/src/bank.ts
const bank = toCli(CustomerApi, {
  name: "bank",
  headers: Config.redacted("BANK_TOKEN").pipe(
    Effect.map((token) => ({ authorization: `Bearer ${Redacted.value(token)}` })),
  ),
});
Command.run(bank, { version: "1.0.0" }).pipe(
  Effect.provide(
    Layer.mergeAll(
      Domain.protocolHttp(url).pipe(Layer.provide(FetchHttpClient.layer)),
      BunServices.layer,
    ),
  ),
  BunRuntime.runMain,
);
```

Fields are flags, and the result is JSON on stdout; a rejection is its wire JSON on stderr with exit code 1:

```sh
$ bank deposit-money --target a-1 --amount 1000
$ bank account-summary get --key a-1
```

More: [CLI](https://alchemy.run/domain/cli).

## Deploying

The root `alchemy.run.ts` yields the server Worker and the foldkit website (see [layout.md](layout.md)). Deploy with `alchemy deploy`, develop with `alchemy dev`, and tear down with `alchemy destroy`.

More: [Cloudflare: Deploy it](https://alchemy.run/domain/cloudflare#deploy-it), [Cloudflare: Deploy without dropping requests](https://alchemy.run/domain/cloudflare#deploy-without-dropping-requests).

## Observability

Every command, event and reaction is traced automatically:
- `Domain.send` and `Domain.decide` spans for commands, with a span event per committed event.
- `Domain.policy` and `Domain.view` spans that continue the trace of the commit they react to.
- `Domain.saga` and `Domain.projection` spans that start their own trace and link back to their cause.
- `Domain.external` spans for external system calls.

All of them carry `domain.correlation_id`, the first command of the flow, which finds a whole flow across traces. Export to an OpenTelemetry backend to see each flow as one connected trace: declare an `Axiom.Dataset` per signal and an `Axiom.ApiToken` that may ingest into them, and add `Axiom.Telemetry({ token, traces, logs })` to the Worker's single `Effect.provide` (or `Alchemy.Telemetry.layerOtlp` for any OTLP endpoint). Name datasets per stage. `Cloudflare.Telemetry()` shows spans in Cloudflare's dashboard instead, but Cloudflare starts a new trace per Worker or Durable Object event, so flows don't connect and browser spans can't be added.

Metrics: `domain.commands`, `domain.command.duration`, `domain.events`, `domain.lag` (commit to handling), `domain.runs`, `domain.projection.batch_size`, `domain.external.calls`. Turn off view spans with `Bank.layer(handlers, { telemetry: { views: false } })`.

More: [Observability](https://alchemy.run/domain/observability).

## Pitfalls

- Durable Object calls right after a fresh deploy can briefly hit alchemy's placeholder script. The Domain platform retries its own calls, so make test readiness probes retry the first real request.
- Never keep per-request objects (sockets, promises) across events in a Durable Object or Worker. Resolve services at init, and do I/O per request.
- Handlers may require `RuntimeContext` (for bindings); every platform provides it when it runs them.
- Models never share data. Two models that list the same aggregate each get their own instances: on Cloudflare, Durable Object classes named after the model (`Billing.AccountAggregate`). Two models with the same name on one platform fail.
- Deploys keep data across Domain layout changes. Upgrading models that shared a class before Domain versions existed fails until one sets `legacyData: true` on its `layer`.

More: [Cloudflare: Know what runs where](https://alchemy.run/domain/cloudflare#know-what-runs-where), [Cloudflare: Host several models in one Worker](https://alchemy.run/domain/cloudflare#host-several-models-in-one-worker), [Cloudflare: Upgrade without losing data](https://alchemy.run/domain/cloudflare#upgrade-without-losing-data).

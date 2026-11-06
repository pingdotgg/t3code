import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Stripe from "@alchemy.run/stripe";
import { Account } from "@bank/domain/Account/Account.aggregate";
import { AccountSummary } from "@bank/domain/Account/AccountSummary.view";
import { Bank, BankHandlers } from "@bank/domain/Bank.model";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { LedgerStore } from "@bank/domain/Ledger/LedgerStore";
import { SupportApi } from "@bank/domain/SupportApi.api";
import * as Telemetry from "alchemy/Telemetry";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SiftFraudCheck } from "./Fraud/SiftFraudCheck.ts";
import { D1LedgerStore } from "./Ledger/D1LedgerStore.ts";
import { MfaChallengeLive } from "./MfaChallenge.ts";
import { Observability } from "./Observability.ts";
import { actorOf, SessionKey, SessionKeyLive, SessionLive, sessionRoute } from "./Session.ts";
import { StripePayments } from "./Settlement/StripePayments.ts";
import { StripeSettlements } from "./Settlement/StripeSettlements.ts";

/**
 * Everything the Worker serves: the middleware both Apis declare, and the
 * Bank hosted on Durable Objects, with the ledger in D1. Swap
 * `DomainCloudflare.layerDurableObjects()` for `Domain.InMemory` and nothing else changes.
 */
const BankLive = Layer.mergeAll(
  SessionLive,
  MfaChallengeLive,
  Stripe.ConsumeEventsLive,
  Observability,
).pipe(
  Layer.provideMerge(SessionKeyLive),
  Layer.provideMerge(Bank.layer(BankHandlers)),
  Layer.provideMerge(D1LedgerStore),
  Layer.provide(
    Layer.mergeAll(
      DomainCloudflare.layerDurableObjects(),
      SiftFraudCheck,
      StripePayments,
      Cloudflare.D1.QueryDatabaseBinding,
    ),
  ),
);

/** `/api/ledger/<account>`: the ledger is a store the bank owns, so it is served by a plain route. */
const LEDGER = /^\/api\/ledger\/([^/]+)$/;

export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
  "BankWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const customerApi = yield* CustomerApi;
    const supportApi = yield* SupportApi;
    const ledger = yield* LedgerStore;
    const summaries = yield* AccountSummary;
    const sessionKey = yield* SessionKey;
    const signedIn = (request: HttpServerRequest) =>
      actorOf(request.headers).pipe(Effect.provideService(SessionKey, sessionKey));
    const ledgerRoute = (accountId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const actor = yield* signedIn(request);
        if (Option.isNone(actor)) return HttpServerResponse.empty({ status: 401 });
        const summary = yield* summaries.query(Account.ref(accountId)).pipe(Effect.orDie);
        const owner = Option.getOrNull(summary)?.customerId;
        if (actor.value._tag === "Customer" && owner !== actor.value.customerId) {
          return HttpServerResponse.empty({ status: 404 });
        }
        return yield* HttpServerResponse.json(yield* ledger.forAccount(accountId));
      });
    // The app's own telemetry, collected here and forwarded with the bank's
    // credentials, so no ingest token reaches a browser. Signed-in users only.
    const telemetry = Telemetry.relay({
      authorize: HttpServerRequest.pipe(Effect.flatMap(signedIn), Effect.map(Option.isSome)),
    });
    // Claims POST /webhooks/stripe and provisions the Stripe webhook endpoint.
    yield* StripeSettlements;
    return {
      // The foldkit app reaches /api through its own Worker, on its own origin,
      // so the session cookie needs no cross-origin allowances.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/api/session") {
          return yield* sessionRoute.pipe(Effect.provideService(SessionKey, sessionKey));
        }
        const ledgerPath = LEDGER.exec(path);
        if (ledgerPath) return yield* ledgerRoute(decodeURIComponent(ledgerPath[1]!));
        if (path.startsWith("/api/telemetry/")) return yield* telemetry;
        if (path.startsWith("/api")) return yield* customerApi.fetch;
        if (path.startsWith("/support")) return yield* supportApi.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(BankLive)),
) {}

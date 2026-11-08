import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  Account,
  Audit,
  Billing,
  Open,
  OpenAccount,
  OpenAccountLive,
  Owners,
  Sales,
  Support,
} from "./isolation.ts";

const Platform = DomainCloudflare.layerDurableObjects();

/** Billing's and Audit's Account and Owners. */
const views = Effect.all({
  Billing: Effect.all({ accounts: Account, owners: Owners }).pipe(
    Effect.provide(Billing.layer(Layer.empty).pipe(Layer.provide(Platform))),
  ),
  Audit: Effect.all({ accounts: Account, owners: Owners }).pipe(
    Effect.provide(Audit.layer(Layer.empty).pipe(Layer.provide(Platform))),
  ),
});

/** Sales' and Support's Account and OpenAccount runs. */
const sagas = Effect.all({
  Sales: Effect.all({ accounts: Account, runs: OpenAccount }).pipe(
    Effect.provide(Sales.layer(OpenAccountLive).pipe(Layer.provide(Platform))),
  ),
  Support: Effect.all({ accounts: Account, runs: OpenAccount }).pipe(
    Effect.provide(Support.layer(OpenAccountLive).pipe(Layer.provide(Platform))),
  ),
});

/** `POST /saga/<model>/<key>/<owner>` runs OpenAccount to the end and answers the model's Account. */
const SAGA_ROUTE = /^\/saga\/(Sales|Support)\/([^/]+)\/([^/]+)$/;

/**
 * `POST /<model>/open/<id>/<owner>`, `GET /<model>/state/<id>` and
 * `GET /<model>/owners/<id>`, where `<model>` is `Billing` or `Audit`.
 */
const ROUTE = /^\/(Billing|Audit)\/(open|state|owners)\/([^/]+)(?:\/([^/]+))?$/;

export default class DomainIsolationWorker extends Cloudflare.Worker<DomainIsolationWorker>()(
  "DomainIsolationWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hosted = yield* views;
    const runs = yield* sagas;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        const saga = SAGA_ROUTE.exec(path);
        if (saga) {
          const { accounts, runs: openAccount } = runs[saga[1] as "Sales" | "Support"];
          const key = decodeURIComponent(saga[2]!);
          const run = yield* openAccount.start(key, { owner: saga[3]! });
          yield* run.result;
          return yield* HttpServerResponse.json(yield* accounts.state(key));
        }
        const route = ROUTE.exec(path);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const { accounts, owners } = hosted[route[1] as "Billing" | "Audit"];
        const id = decodeURIComponent(route[3]!);
        if (route[2] === "open") {
          const receipt = yield* accounts.send(id, new Open({ owner: route[4]! }));
          return yield* HttpServerResponse.json({ version: receipt.version });
        }
        if (route[2] === "owners")
          return yield* HttpServerResponse.json(
            Option.getOrNull(yield* owners.query(Account.ref(id)).pipe(Effect.orDie)),
          );
        return yield* HttpServerResponse.json(yield* accounts.state(id));
      }).pipe(
        // Answer a failure with its cause, so a failed test shows why.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}

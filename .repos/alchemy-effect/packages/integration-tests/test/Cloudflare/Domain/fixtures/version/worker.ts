import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  Account,
  Deposit,
  type Latest,
  type LatestOfV1,
  type Summary,
  type SummaryV1,
  Withdraw,
} from "./model.ts";

/**
 * The Bank Worker's routes, on whichever model a deploy hosts:
 * `POST /deposit/<account>/<amount>`, `POST /withdraw/<account>/<amount>`,
 * `GET /summary/<account>`, `GET /latest/<account>` and `GET /version`.
 */
export const bankWorker = (
  version: string,
  summaryView: typeof Summary | typeof SummaryV1,
  latestView: typeof Latest | typeof LatestOfV1,
) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    const summary = yield* summaryView;
    const latest = yield* latestView;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, id, amount] = new URL(request.url, "http://localhost").pathname.split("/");
        if (route === "version") return HttpServerResponse.text(version);
        if (route === "summary")
          return yield* HttpServerResponse.json(
            Option.getOrNull(yield* summary.query(Account.ref(id!))),
          );
        if (route === "latest")
          return yield* HttpServerResponse.json(
            Option.getOrNull(yield* latest.query(Account.ref(id!))),
          );
        if (route === "deposit" || route === "withdraw") {
          const command =
            route === "deposit"
              ? new Deposit({ amount: Number(amount) })
              : new Withdraw({ amount: Number(amount) });
          yield* accounts.send(id!, command);
          return yield* HttpServerResponse.json(yield* accounts.state(id!));
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchTag("ConsistencyTimeout", () =>
          Effect.succeed(HttpServerResponse.text("not caught up", { status: 503 })),
        ),
        Effect.orDie,
      ),
    };
  });

/** Host a model on Durable Objects. */
export const hosted = <L extends Layer.Layer<any, any, any>>(model: L) =>
  model.pipe(Layer.provide(DomainCloudflare.layerDurableObjects()));

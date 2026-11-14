import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  Account,
  Deposit,
  type Deposits,
  type DoubledDeposits,
  type Timeline,
  type WideTimeline,
  type WideTimelineV1,
} from "./ledger.ts";

/**
 * The Ledger Worker's routes, on whichever model a deploy hosts:
 * `POST /deposit/<account>/<amount>`, `GET /deposits/<account>`,
 * `GET /history` (the view's) and `GET /version`.
 */
export const ledgerWorker = (
  version: string,
  deposits?: typeof Deposits | typeof DoubledDeposits,
  timelineView?: typeof Timeline | typeof WideTimeline | typeof WideTimelineV1,
) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    const view = deposits ? yield* deposits : undefined;
    const timeline = timelineView ? yield* timelineView : undefined;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname.split("/");
        if (path[1] === "version") return HttpServerResponse.text(version);
        if (path[1] === "deposits" && view) {
          const state = yield* view.query(Account.ref(path[2]!));
          return yield* HttpServerResponse.json(Option.getOrNull(state));
        }
        if (path[1] === "timeline" && timeline) {
          return yield* HttpServerResponse.json(Option.getOrNull(yield* timeline.query("all")));
        }
        if (path[1] === "history" && view) {
          return yield* HttpServerResponse.json(yield* view.history);
        }
        if (path[1] !== "deposit") return HttpServerResponse.text("Not Found", { status: 404 });
        yield* accounts.send(path[2]!, new Deposit({ amount: Number(path[3]) }));
        return yield* HttpServerResponse.json(yield* accounts.state(path[2]!));
      }).pipe(
        Effect.catchTag("ConsistencyTimeout", () =>
          Effect.succeed(HttpServerResponse.text("not caught up", { status: 503 })),
        ),
      ),
    };
  });

/** Host a model on Durable Objects. */
export const hosted = <L extends Layer.Layer<any, any, any>>(
  model: L,
  options?: DomainCloudflare.DurableObjectsOptions,
) => model.pipe(Layer.provide(DomainCloudflare.layerDurableObjects(options)));

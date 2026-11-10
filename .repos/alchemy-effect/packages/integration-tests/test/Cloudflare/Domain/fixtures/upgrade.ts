import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { DeployVersion } from "@alchemy.run/cloudflare/Domain/Version";
import * as Domain from "@alchemy.run/domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Activity, DurableDeferred } from "effect/workflow";
import { Account, Open, Owners } from "./isolation.ts";

/** The approval a run of {@link Approve} waits for. */
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

/** Opens the account once someone approves it. */
export class Approve extends Domain.Saga("Approve", {
  key: Schema.String,
  input: { owner: Schema.String },
}) {}
export const ApproveLive = Approve.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ key, owner }) {
      const approvedBy = yield* DurableDeferred.await(Approval);
      yield* Activity.make({
        name: "open",
        execute: accounts
          .send(key, new Open({ owner: `${owner}:${approvedBy}` }))
          .pipe(Effect.asVoid),
      });
    });
  }),
);

export class Billing extends Domain.Model("Billing", {
  aggregates: [Account],
  views: [Owners],
  sagas: [Approve],
}) {}
export class Audit extends Domain.Model("Audit", { aggregates: [Account], views: [Owners] }) {}

/**
 * `POST /<model>/open/<id>/<owner>`, `GET /<model>/state/<id>`,
 * `GET /<model>/owners/<id>`, `POST /saga/<key>/<owner>` (starts a run),
 * `GET /saga/<key>` (its status), `POST /approve/<key>/<by>` and
 * `GET /version`.
 */
const ROUTE = /^\/(Billing|Audit)\/(open|state|owners)\/([^/]+)(?:\/([^/]+))?$/;
const SAGA = /^\/(saga|approve)\/([^/]+)(?:\/([^/]+))?$/;

/**
 * A Worker hosting Billing, and Audit when `audit` is set, laid out as Domain
 * version `version` lays them out: `undefined` for the layout from before
 * versions existed.
 */
export const upgradeWorker = ({
  version,
  audit,
  legacyData,
}: {
  readonly version: number | undefined;
  readonly audit: boolean;
  readonly legacyData?: "Billing" | "Audit";
}) =>
  Effect.gen(function* () {
    const Platform = DomainCloudflare.layerDurableObjects();
    const billing = yield* Effect.all({ accounts: Account, owners: Owners, runs: Approve }).pipe(
      Effect.provide(
        Billing.layer(ApproveLive, { legacyData: legacyData === "Billing" }).pipe(
          Layer.provide(Platform),
        ),
      ),
    );
    const models = {
      Billing: billing,
      Audit: audit
        ? yield* Effect.all({ accounts: Account, owners: Owners }).pipe(
            Effect.provide(
              Audit.layer(Layer.empty, { legacyData: legacyData === "Audit" }).pipe(
                Layer.provide(Platform),
              ),
            ),
          )
        : undefined,
    };
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/version")
          return yield* HttpServerResponse.json({ version: version ?? null });
        const saga = SAGA.exec(path);
        if (saga) {
          const key = decodeURIComponent(saga[2]!);
          if (saga[1] === "approve") {
            yield* billing.runs.get(key).signal(Approval, saga[3]!);
            return yield* HttpServerResponse.json({ approved: true });
          }
          if (request.method === "POST") {
            yield* billing.runs.start(key, { owner: saga[3]! });
            return yield* HttpServerResponse.json({ started: true });
          }
          return yield* HttpServerResponse.json(yield* billing.runs.get(key).status);
        }
        const route = ROUTE.exec(path);
        const model = route ? models[route[1] as "Billing" | "Audit"] : undefined;
        if (!route || !model) return HttpServerResponse.text("Not Found", { status: 404 });
        const id = decodeURIComponent(route[3]!);
        if (route[2] === "open") {
          const receipt = yield* model.accounts.send(id, new Open({ owner: route[4]! }));
          return yield* HttpServerResponse.json({ version: receipt.version });
        }
        if (route[2] === "owners")
          return yield* HttpServerResponse.json(
            Option.getOrNull(yield* model.owners.query(Account.ref(id)).pipe(Effect.orDie)),
          );
        return yield* HttpServerResponse.json(yield* model.accounts.state(id));
      }).pipe(
        // Answer a failure with its cause, so a failed test shows why.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provideService(DeployVersion, version));

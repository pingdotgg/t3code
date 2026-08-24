import * as Lambda from "@/AWS/Lambda";
import * as AOSS from "@/AWS/OpenSearchServerless";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class AossBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "AossBindingsFunction",
) {}

export default AossBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Account-level bindings only — free and instant (no collection needed).
    // The collection-scoped index bindings are exercised by the gated
    // IndexBindings.test.ts fixture.
    const getAccountSettings = yield* AOSS.GetAccountSettings();
    const updateAccountSettings = yield* AOSS.UpdateAccountSettings();
    const getPoliciesStats = yield* AOSS.GetPoliciesStats();
    const batchGetEffectiveLifecyclePolicy =
      yield* AOSS.BatchGetEffectiveLifecyclePolicy();

    const bound = {
      getAccountSettings,
      updateAccountSettings,
      getPoliciesStats,
      batchGetEffectiveLifecyclePolicy,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/account-settings") {
          const response = yield* getAccountSettings();
          return yield* HttpServerResponse.json({
            capacityLimits:
              response.accountSettingsDetail?.capacityLimits ?? null,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/account-settings/noop"
        ) {
          // Read-modify-write with the observed values (falling back to the
          // service defaults) — proves the UpdateAccountSettings grant
          // without changing the account's effective configuration.
          const current = yield* getAccountSettings().pipe(
            Effect.map((r) => r.accountSettingsDetail?.capacityLimits),
          );
          const response = yield* updateAccountSettings({
            capacityLimits: {
              maxIndexingCapacityInOCU: current?.maxIndexingCapacityInOCU ?? 10,
              maxSearchCapacityInOCU: current?.maxSearchCapacityInOCU ?? 10,
            },
          });
          return yield* HttpServerResponse.json({
            capacityLimits:
              response.accountSettingsDetail?.capacityLimits ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/policies-stats") {
          const response = yield* getPoliciesStats();
          return yield* HttpServerResponse.json({
            total: response.TotalPolicyCount ?? 0,
            securityPolicies:
              response.SecurityPolicyStats?.EncryptionPolicyCount ?? 0,
          });
        }

        if (request.method === "POST" && pathname === "/effective-lifecycle") {
          // A nonexistent index resolves through the error-detail channel —
          // the call round-tripping at all proves the grant end-to-end (an
          // IAM gap would surface AccessDeniedException, a 500).
          const response = yield* batchGetEffectiveLifecyclePolicy({
            resourceIdentifiers: [
              {
                type: "retention",
                resource: "index/alchemy-nonexistent-probe/probe",
              },
            ],
          });
          return yield* HttpServerResponse.json({
            details: (response.effectiveLifecyclePolicyDetails ?? []).length,
            errors: (response.effectiveLifecyclePolicyErrorDetails ?? [])
              .length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AOSS.GetAccountSettingsHttp,
        AOSS.UpdateAccountSettingsHttp,
        AOSS.GetPoliciesStatsHttp,
        AOSS.BatchGetEffectiveLifecyclePolicyHttp,
      ),
    ),
  ),
);

import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { registerApiGatewayBinding } from "./BindingHttp.ts";
import {
  GetUsagePlanKey,
  type GetUsagePlanKeyRequest,
} from "./GetUsagePlanKey.ts";
import type { UsagePlan } from "./UsagePlan.ts";

/**
 * HTTP implementation of the {@link GetUsagePlanKey} binding. Grants
 * `apigateway:GET` on the plan's per-key paths and calls the API with the
 * host Function's credentials.
 */
export const GetUsagePlanKeyHttp = Layer.effect(
  GetUsagePlanKey,
  Effect.gen(function* () {
    const getUsagePlanKey = yield* ag.getUsagePlanKey;
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetUsagePlanKey",
        target: usagePlan,
        verb: "GET",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/keys/*`,
        ],
      });
      return Effect.fn(
        `AWS.ApiGateway.GetUsagePlanKey(${usagePlan.LogicalId})`,
      )(function* (request: GetUsagePlanKeyRequest) {
        return yield* getUsagePlanKey({
          ...request,
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);

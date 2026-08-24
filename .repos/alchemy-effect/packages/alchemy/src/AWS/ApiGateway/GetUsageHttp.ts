import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { registerApiGatewayBinding } from "./BindingHttp.ts";
import { GetUsage, type GetUsageRequest } from "./GetUsage.ts";
import type { UsagePlan } from "./UsagePlan.ts";

/**
 * HTTP implementation of the {@link GetUsage} binding. Grants
 * `apigateway:GET` on the plan's `/usage` path and calls the API with the
 * host Function's credentials.
 */
export const GetUsageHttp = Layer.effect(
  GetUsage,
  Effect.gen(function* () {
    const getUsage = yield* ag.getUsage;
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetUsage",
        target: usagePlan,
        verb: "GET",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/usage`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.GetUsage(${usagePlan.LogicalId})`)(
        function* (request: GetUsageRequest) {
          return yield* getUsage({
            ...request,
            usagePlanId: yield* UsagePlanId,
          });
        },
      );
    });
  }),
);

import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { registerApiGatewayBinding } from "./BindingHttp.ts";
import {
  CreateUsagePlanKey,
  type CreateUsagePlanKeyRequest,
} from "./CreateUsagePlanKey.ts";
import type { UsagePlan } from "./UsagePlan.ts";

/**
 * HTTP implementation of the {@link CreateUsagePlanKey} binding. Grants
 * `apigateway:POST` on the plan's `/keys` path and calls the API with the
 * host Function's credentials.
 */
export const CreateUsagePlanKeyHttp = Layer.effect(
  CreateUsagePlanKey,
  Effect.gen(function* () {
    const createUsagePlanKey = yield* ag.createUsagePlanKey;
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.CreateUsagePlanKey",
        target: usagePlan,
        verb: "POST",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/keys`,
        ],
      });
      return Effect.fn(
        `AWS.ApiGateway.CreateUsagePlanKey(${usagePlan.LogicalId})`,
      )(function* (request: CreateUsagePlanKeyRequest) {
        return yield* createUsagePlanKey({
          ...request,
          keyType: request.keyType ?? "API_KEY",
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);

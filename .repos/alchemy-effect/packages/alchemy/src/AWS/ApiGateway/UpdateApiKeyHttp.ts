import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { registerApiGatewayBinding } from "./BindingHttp.ts";
import { UpdateApiKey, type UpdateApiKeyRequest } from "./UpdateApiKey.ts";

/**
 * HTTP implementation of the {@link UpdateApiKey} binding. Grants
 * `apigateway:PATCH` on `/apikeys/*` and calls the API with the host
 * Function's credentials.
 */
export const UpdateApiKeyHttp = Layer.effect(
  UpdateApiKey,
  Effect.gen(function* () {
    const updateApiKey = yield* ag.updateApiKey;
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.UpdateApiKey",
        target: "",
        verb: "PATCH",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys/*`],
      });
      return Effect.fn("AWS.ApiGateway.UpdateApiKey")(function* (
        request: UpdateApiKeyRequest,
      ) {
        return yield* updateApiKey(request);
      });
    });
  }),
);

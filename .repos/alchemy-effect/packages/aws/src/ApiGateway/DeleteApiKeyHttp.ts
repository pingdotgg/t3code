import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import { DeleteApiKey, type DeleteApiKeyRequest } from "./DeleteApiKey.ts";

/**
 * HTTP implementation of the {@link DeleteApiKey} binding. Grants
 * `apigateway:DELETE` on `/apikeys/*` and calls the API with the host
 * Function's credentials.
 */
export const DeleteApiKeyHttp = Layer.effect(
  DeleteApiKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const deleteApiKey = yield* AWSBindings.withCredentials(ag.deleteApiKey);
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.DeleteApiKey",
        target: "",
        verb: "DELETE",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys/*`],
      });
      return Effect.fn("AWS.ApiGateway.DeleteApiKey")(function* (request: DeleteApiKeyRequest) {
        return yield* deleteApiKey(request);
      });
    });
  }),
);

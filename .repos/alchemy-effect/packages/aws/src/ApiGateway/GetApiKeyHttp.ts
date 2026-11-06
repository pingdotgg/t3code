import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import { GetApiKey, type GetApiKeyRequest } from "./GetApiKey.ts";

/**
 * HTTP implementation of the {@link GetApiKey} binding. Grants
 * `apigateway:GET` on `/apikeys/*` and calls the API with the host
 * Function's credentials.
 */
export const GetApiKeyHttp = Layer.effect(
  GetApiKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const getApiKey = yield* AWSBindings.withCredentials(ag.getApiKey);
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetApiKey",
        target: "",
        verb: "GET",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys/*`],
      });
      return Effect.fn("AWS.ApiGateway.GetApiKey")(function* (request: GetApiKeyRequest) {
        return yield* getApiKey(request);
      });
    });
  }),
);

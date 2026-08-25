import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { registerApiGatewayBinding } from "./BindingHttp.ts";
import { GetApiKeys, type GetApiKeysRequest } from "./GetApiKeys.ts";

/**
 * HTTP implementation of the {@link GetApiKeys} binding. Grants
 * `apigateway:GET` on `/apikeys` and calls the API with the host
 * Function's credentials.
 */
export const GetApiKeysHttp = Layer.effect(
  GetApiKeys,
  Effect.gen(function* () {
    const getApiKeys = yield* ag.getApiKeys;
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetApiKeys",
        target: "",
        verb: "GET",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys`],
      });
      return Effect.fn("AWS.ApiGateway.GetApiKeys")(function* (
        request?: GetApiKeysRequest,
      ) {
        return yield* getApiKeys(request ?? {});
      });
    });
  }),
);

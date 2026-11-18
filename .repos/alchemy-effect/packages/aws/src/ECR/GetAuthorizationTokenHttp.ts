import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GetAuthorizationToken } from "./GetAuthorizationToken.ts";

/**
 * HTTP implementation of {@link GetAuthorizationToken} over the ECR API.
 * Registry-level (not repository-scoped): the token authorizes Docker
 * `login` against the whole private registry, and `ecr:GetAuthorizationToken`
 * supports no resource-level permissions, so the grant is on `"*"`.
 */
export const GetAuthorizationTokenHttp = Layer.effect(
  GetAuthorizationToken,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(ecr.getAuthorizationToken);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ECR.GetAuthorizationToken()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["ecr:GetAuthorizationToken"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn("AWS.ECR.GetAuthorizationToken")(function* () {
        return yield* op({});
      });
    });
  }),
);

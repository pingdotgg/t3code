import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AccessKey } from "./AccessKey.ts";
import { GetAccessKeyLastUsed } from "./GetAccessKeyLastUsed.ts";

/**
 * Bespoke (resource-bound) IAM HTTP binding: unlike the account-level
 * bindings built on `makeIamHttpBinding`, this one binds a canonical
 * {@link AccessKey} and injects its `AccessKeyId` into every request.
 */
export const GetAccessKeyLastUsedHttp = Layer.effect(
  GetAccessKeyLastUsed,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(iam.getAccessKeyLastUsed);

    return Effect.fn(function* <K extends AccessKey>(accessKey: K) {
      const AccessKeyId = yield* accessKey.accessKeyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.IAM.GetAccessKeyLastUsed(${accessKey})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["iam:GetAccessKeyLastUsed"],
              // The action is evaluated against the owning *user*, whose
              // path-qualified ARN is not derivable from the access key.
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.IAM.GetAccessKeyLastUsed(${accessKey.LogicalId})`)(function* () {
        return yield* op({ AccessKeyId: yield* AccessKeyId });
      });
    });
  }),
);

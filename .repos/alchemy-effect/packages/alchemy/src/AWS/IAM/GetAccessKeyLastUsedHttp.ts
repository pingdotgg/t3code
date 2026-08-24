import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
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
    const op = yield* iam.getAccessKeyLastUsed;

    return Effect.fn(function* <K extends AccessKey>(accessKey: K) {
      const AccessKeyId = yield* accessKey.accessKeyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.IAM.GetAccessKeyLastUsed(${accessKey}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["iam:GetAccessKeyLastUsed"],
                  // The action is evaluated against the owning *user*, whose
                  // path-qualified ARN is not derivable from the access key.
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.IAM.GetAccessKeyLastUsed(${accessKey.LogicalId})`)(
        function* () {
          return yield* op({ AccessKeyId: yield* AccessKeyId });
        },
      );
    });
  }),
);

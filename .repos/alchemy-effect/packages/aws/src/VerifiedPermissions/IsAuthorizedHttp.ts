import * as AVP from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import {
  type BatchIsAuthorizedRequest,
  type BatchIsAuthorizedWithTokenRequest,
  IsAuthorized,
  type IsAuthorizedRequest,
  type IsAuthorizedWithTokenRequest,
} from "./IsAuthorized.ts";
import type { PolicyStore } from "./PolicyStore.ts";

export const IsAuthorizedHttp = Layer.effect(
  IsAuthorized,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const isAuthorized = yield* AWSBindings.withCredentials(AVP.isAuthorized);
    const isAuthorizedWithToken = yield* AWSBindings.withCredentials(AVP.isAuthorizedWithToken);
    const batchIsAuthorized = yield* AWSBindings.withCredentials(AVP.batchIsAuthorized);
    const batchIsAuthorizedWithToken = yield* AWSBindings.withCredentials(
      AVP.batchIsAuthorizedWithToken,
    );

    return Effect.fn(function* <S extends PolicyStore>(store: S) {
      const PolicyStoreId = yield* store.policyStoreId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.VerifiedPermissions.IsAuthorized(${store})`({
          policyStatements: [
            {
              Effect: "Allow",
              // the batch operations authorize under the non-batch
              // verifiedpermissions:IsAuthorized[WithToken] actions
              Action: [
                "verifiedpermissions:IsAuthorized",
                "verifiedpermissions:IsAuthorizedWithToken",
                "verifiedpermissions:BatchIsAuthorized",
                "verifiedpermissions:BatchIsAuthorizedWithToken",
              ],
              Resource: [store.policyStoreArn],
            },
          ],
        });
      }
      const label = store.LogicalId;
      return {
        isAuthorized: Effect.fn(`AWS.VerifiedPermissions.IsAuthorized(${label})`)(function* (
          request: IsAuthorizedRequest,
        ) {
          const policyStoreId = yield* PolicyStoreId;
          return yield* isAuthorized({ ...request, policyStoreId });
        }),
        isAuthorizedWithToken: Effect.fn(`AWS.VerifiedPermissions.IsAuthorizedWithToken(${label})`)(
          function* (request: IsAuthorizedWithTokenRequest) {
            const policyStoreId = yield* PolicyStoreId;
            return yield* isAuthorizedWithToken({ ...request, policyStoreId });
          },
        ),
        batchIsAuthorized: Effect.fn(`AWS.VerifiedPermissions.BatchIsAuthorized(${label})`)(
          function* (request: BatchIsAuthorizedRequest) {
            const policyStoreId = yield* PolicyStoreId;
            return yield* batchIsAuthorized({ ...request, policyStoreId });
          },
        ),
        batchIsAuthorizedWithToken: Effect.fn(
          `AWS.VerifiedPermissions.BatchIsAuthorizedWithToken(${label})`,
        )(function* (request: BatchIsAuthorizedWithTokenRequest) {
          const policyStoreId = yield* PolicyStoreId;
          return yield* batchIsAuthorizedWithToken({
            ...request,
            policyStoreId,
          });
        }),
      };
    });
  }),
);

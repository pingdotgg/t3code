import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { IPSet } from "./IPSet.ts";
import { retryOptimisticLock, withWafScope } from "./internal.ts";
import { UpdateIPSet, type UpdateIPSetRequest } from "./UpdateIPSet.ts";

/**
 * Bespoke (multi-op) binding: reads the IP set for a fresh `LockToken`,
 * applies the full-replacement update, and retries optimistic-lock
 * conflicts by re-reading.
 */
export const UpdateIPSetHttp = Layer.effect(
  UpdateIPSet,
  Effect.gen(function* () {
    const get = yield* wafv2.getIPSet;
    const update = yield* wafv2.updateIPSet;

    return Effect.fn(function* (ipSet: IPSet) {
      const Name = yield* ipSet.ipSetName;
      const Id = yield* ipSet.ipSetId;
      const Scope = yield* ipSet.scope;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.WAFv2.UpdateIPSet(${ipSet}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["wafv2:GetIPSet", "wafv2:UpdateIPSet"],
                Resource: [ipSet.ipSetArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.WAFv2.UpdateIPSet(${ipSet.LogicalId})`)(function* (
        request: UpdateIPSetRequest,
      ) {
        const scope = yield* Scope;
        const key = { Name: yield* Name, Scope: scope, Id: yield* Id };
        return yield* retryOptimisticLock(
          withWafScope(
            scope,
            Effect.gen(function* () {
              const fresh = yield* get(key);
              return yield* update({
                ...key,
                Addresses: request.addresses,
                Description: request.description ?? fresh.IPSet?.Description,
                LockToken: fresh.LockToken ?? "",
              });
            }),
          ),
        );
      });
    });
  }),
);

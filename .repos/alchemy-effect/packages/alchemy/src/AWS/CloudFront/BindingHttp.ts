import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { KVS_REGION } from "./common.ts";
import type { Distribution } from "./Distribution.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";

/**
 * Shared scaffolding for CloudFront HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation, the IAM action list, and the
 * injected identifier is boilerplate.
 */

/**
 * Build the impl Effect for a distribution-scoped operation. The runtime
 * callable injects the bound {@link Distribution}'s id as the request's
 * `DistributionId`; the deploy-time half grants `actions` on the
 * distribution's ARN.
 */
export const makeDistributionScopedHttpBinding = <
  I extends { DistributionId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudFront.GetInvalidation`. */
  tag: string;
  /** The distilled operation; `DistributionId` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the distribution ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (distribution: Distribution) {
      const DistributionId = yield* distribution.distributionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${distribution}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [distribution.distributionArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${distribution.LogicalId})`)(function* (
        request: Omit<I, "DistributionId">,
      ) {
        return yield* op({
          ...request,
          DistributionId: yield* DistributionId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a KeyValueStore data-plane operation
 * (`cloudfront-keyvaluestore`). The runtime callable injects the bound
 * {@link KeyValueStore}'s ARN as the request's `KvsARN`; the deploy-time half
 * grants `actions` on the store's ARN. The data-plane endpoint is global
 * (derived from the ARN), but distilled signs with plain SigV4 against the
 * context region and the service only accepts `us-east-1` signatures — so
 * the operation is resolved with the Region pinned to {@link KVS_REGION},
 * exactly like the resource providers in `common.ts`.
 */
export const makeKeyValueStoreScopedHttpBinding = <
  I extends { KvsARN: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudFront.GetKey`. */
  tag: string;
  /** The distilled operation; `KvsARN` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the KeyValueStore ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    // The distilled Region service value is `Effect<RegionName>`, not a raw
    // string (see `withKvsRegion` in common.ts).
    const op = yield* options.operation.pipe(
      Effect.provideService(AwsRegion, Effect.succeed(KVS_REGION)),
    );

    return Effect.fn(function* (store: KeyValueStore) {
      const KvsARN = yield* store.keyValueStoreArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${store}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [store.keyValueStoreArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${store.LogicalId})`)(function* (
        request: Omit<I, "KvsARN">,
      ) {
        return yield* op({
          ...request,
          KvsARN: yield* KvsARN,
        } as I);
      });
    });
  });

import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared scaffolding for the IAM Identity Center runtime bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate:
 *
 * - {@link makeIdentityStoreHttpBinding} — Identity Store data-plane
 *   operations (`identitystore:*` actions: user CRUD, group lookups,
 *   membership management). The runtime callable injects the bound
 *   {@link Instance}'s `IdentityStoreId`; the deploy-time half grants
 *   `actions` on the identity store ARN plus the region-less
 *   `user/*`/`group/*`/`membership/*` sub-resource ARNs the actions require.
 * - {@link makeIdentityCenterInstanceHttpBinding} — `sso:*` admin reads
 *   scoped to the bound {@link Instance} (account-assignment audit,
 *   permission set reads). The runtime callable injects the instance's
 *   `InstanceArn`; the deploy-time half grants `actions` on the instance ARN
 *   plus the region-less `permissionSet/*` and `account/*` ARNs.
 */

/**
 * Build the impl Effect for an Identity Store data-plane operation scoped to
 * one {@link Instance}: the deploy-time half grants `actions` on the
 * identity store ARN (`arn:aws:identitystore::{account}:identitystore/{id}`)
 * and the `user/*`/`group/*`/`membership/*` sub-resources, and the runtime
 * half injects the instance's `IdentityStoreId` into every request.
 */
export const makeIdentityStoreHttpBinding = <
  I extends { IdentityStoreId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IdentityCenter.DescribeUser`. */
  tag: string;
  /** The distilled operation; `IdentityStoreId` is injected from the instance. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the identity store + sub-resource ARNs. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (instance: Instance) {
      const IdentityStoreId = yield* instance.identityStoreId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
            }>;
          yield* host.bind`Allow(${host}, ${options.tag}(${instance}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`arn:aws:identitystore::${accountId}:identitystore/${instance.identityStoreId}`,
                  // Identity Store sub-resources are region-less and
                  // account-less; the concrete user/group/membership ids
                  // are chosen per request at runtime.
                  "arn:aws:identitystore:::user/*",
                  "arn:aws:identitystore:::group/*",
                  "arn:aws:identitystore:::membership/*",
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "IdentityStoreId">,
      ) {
        return yield* op({
          ...request,
          IdentityStoreId: yield* IdentityStoreId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an `sso:*` admin operation scoped to one
 * {@link Instance}: the deploy-time half grants `actions` on the instance
 * ARN plus the region-less `permissionSet/*` and `account/*` ARNs, and the
 * runtime half injects the instance's `InstanceArn` into every request.
 */
export const makeIdentityCenterInstanceHttpBinding = <
  I extends { InstanceArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IdentityCenter.ListPermissionSets`. */
  tag: string;
  /** The distilled operation; `InstanceArn` is injected from the instance. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the instance / permission set / account ARNs. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (instance: Instance) {
      const InstanceArn = yield* instance.instanceArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${instance}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${instance.instanceArn}`,
                  // Permission sets and target accounts are chosen per
                  // request at runtime; their ARNs are region-less and
                  // account-less.
                  "arn:aws:sso:::permissionSet/*",
                  "arn:aws:sso:::account/*",
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "InstanceArn">,
      ) {
        return yield* op({
          ...request,
          InstanceArn: yield* InstanceArn,
        } as I);
      });
    });
  });

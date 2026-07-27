import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { isInstance, type Instance } from "./Instance.ts";
import type { SecurityGroup } from "./SecurityGroup.ts";
import type { Volume } from "./Volume.ts";

/**
 * Shared scaffolding for EC2 HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the three builders below (one per bound resource kind). Everything except
 * the operation, the IAM action list, and the injected identifier is
 * boilerplate. Genuinely-different bindings (custom response shaping like
 * `DescribeInstance`) stay bespoke.
 */

/**
 * Build the impl Effect for an operation scoped to a bound {@link Instance}.
 * The runtime callable injects the instance id (as the scalar `InstanceId` or
 * the single-element `InstanceIds` array, per `requestKey`) and the
 * deploy-time half grants `actions` on the instance ARN — or on `*` for
 * `Describe*` actions, which do not support resource-level permissions.
 */
export const makeInstanceHttpBinding = <I extends object, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EC2.StartInstance`. */
  tag: string;
  /** The distilled operation; the instance id is injected from the instance. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted by the binding. */
  actions: readonly string[];
  /** How the operation names the instance in its request. */
  requestKey: "InstanceId" | "InstanceIds";
  /**
   * IAM resource scope. Mutating actions support resource-level permissions
   * on the instance ARN (`"instance"`, the default); `Describe*` actions do
   * not (`"*"`).
   */
  resource?: "instance" | "*";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (instance: Instance) {
      const instanceId = yield* instance.instanceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isInstance(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${instance}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource:
                  options.resource === "*"
                    ? ["*"]
                    : [Output.interpolate`${instance.instanceArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "InstanceId" | "InstanceIds">,
      ) {
        const id = yield* instanceId;
        return yield* op({
          ...request,
          [options.requestKey]:
            options.requestKey === "InstanceIds" ? [id] : id,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation scoped to a bound
 * {@link SecurityGroup}. The runtime callable injects the group id as
 * `GroupId` and the deploy-time half grants `actions` on the security group
 * ARN.
 */
export const makeSecurityGroupHttpBinding = <
  I extends object,
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EC2.AuthorizeSecurityGroupIngress`. */
  tag: string;
  /** The distilled operation; `GroupId` is injected from the group. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the security group ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (group: SecurityGroup) {
      const groupId = yield* group.groupId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isInstance(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${group}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${group.groupArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${group.LogicalId})`)(function* (
        request: Omit<I, "GroupId" | "GroupName">,
      ) {
        return yield* op({
          ...request,
          GroupId: yield* groupId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation scoped to a bound {@link Volume}.
 * The runtime callable injects the volume id as `VolumeId` and the
 * deploy-time half grants `actions` on the volume ARN plus any
 * `extraResources` (e.g. the region-wide snapshot wildcard `CreateSnapshot`
 * also authorizes against).
 */
export const makeVolumeHttpBinding = <I extends object, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EC2.CreateSnapshot`. */
  tag: string;
  /** The distilled operation; `VolumeId` is injected from the volume. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the volume ARN (+ `extraResources`). */
  actions: readonly string[];
  /** Additional IAM resource ARNs (e.g. `arn:aws:ec2:*::snapshot/*`). */
  extraResources?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (volume: Volume) {
      const volumeId = yield* volume.volumeId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isInstance(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${volume}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${volume.volumeArn}`,
                  ...(options.extraResources ?? []),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${volume.LogicalId})`)(function* (
        request?: Omit<I, "VolumeId">,
      ) {
        return yield* op({
          ...request,
          VolumeId: yield* volumeId,
        } as I);
      });
    });
  });

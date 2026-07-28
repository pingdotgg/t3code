import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ComponentVersion } from "./ComponentVersion.ts";
import type { Deployment } from "./Deployment.ts";

/**
 * Shared scaffolding for IoT Greengrass V2 HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a Greengrass V2 operation scoped to a
 * {@link ComponentVersion}: the deploy-time half grants `actions` on the
 * bound component version's ARN, and the runtime half injects the component
 * version's `arn` into every request.
 */
export const makeGreengrassComponentHttpBinding = <
  I extends { arn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.GreengrassV2.GetComponent`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the component version ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (component: ComponentVersion) {
      const Arn = yield* component.arn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${component}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [component.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${component.LogicalId})`)(function* (
        request?: Omit<I, "arn">,
      ) {
        const arn = yield* Arn;
        return yield* op({ ...request, arn } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Greengrass V2 operation scoped to a
 * {@link Deployment}: the deploy-time half grants `actions` on the bound
 * deployment's ARN, and the runtime half injects the `deploymentId` into
 * every request.
 */
export const makeGreengrassDeploymentHttpBinding = <
  I extends { deploymentId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.GreengrassV2.GetDeployment`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the deployment ARN. */
  actions: readonly string[];
  /**
   * Dependent IAM actions granted on `*`. Greengrass V2 deployments are
   * implemented on IoT Jobs and resolve their thing/thing-group targets with
   * the caller's credentials, so deployment-plane operations require
   * `iot:DescribeJob`/`iot:DescribeThing`-family permissions (see the
   * "dependent actions" column of the service authorization reference).
   * These cannot be scoped to the deployment ARN — the backing job and
   * target thing have their own ARNs.
   */
  dependentActions?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (deployment: Deployment) {
      const DeploymentId = yield* deployment.deploymentId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${deployment}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [deployment.deploymentArn],
              },
              ...(options.dependentActions !== undefined &&
              options.dependentActions.length > 0
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: [...options.dependentActions],
                      Resource: ["*"],
                    },
                  ]
                : []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${deployment.LogicalId})`)(function* (
        request?: Omit<I, "deploymentId">,
      ) {
        const deploymentId = yield* DeploymentId;
        return yield* op({ ...request, deploymentId } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Greengrass V2 operation (listing
 * components/deployments/core devices, core-device data-plane calls keyed by
 * a thing name the caller supplies at runtime). The deploy-time half grants
 * `actions` on `*` — core devices register themselves and are not modeled as
 * Alchemy resources, so there is no resource ARN to scope down to.
 */
export const makeGreengrassAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.GreengrassV2.ListComponents`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

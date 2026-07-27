import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Application } from "./Application.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Shared scaffolding for AWS CodeDeploy HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action, and (for
 * name-injecting operations) the injected `applicationName` /
 * `deploymentGroupName` is boilerplate.
 *
 * CodeDeploy authorizes deployment-addressed operations (get/stop/continue a
 * deployment, lifecycle-hook results, deployment targets) against the
 * *deployment group* the deployment belongs to, and revision operations
 * against the *application* ARN — so every builder grants on the bound
 * resource's ARN.
 */

/**
 * Build the impl Effect for an operation whose input carries
 * `applicationName` + `deploymentGroupName` fields: the runtime callable
 * injects both from the bound {@link DeploymentGroup} and the deploy-time
 * half grants `actions` on the deployment-group ARN.
 */
export const makeCodeDeployGroupNameHttpBinding = <
  I extends { applicationName?: string; deploymentGroupName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodeDeploy.ListDeployments`. */
  tag: string;
  /**
   * The distilled operation; `applicationName` and `deploymentGroupName`
   * are injected from the group.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the deployment-group ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <G extends DeploymentGroup>(group: G) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const ApplicationName = yield* group.applicationName;
      const DeploymentGroupName = yield* group.deploymentGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${group}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${group.deploymentGroupArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${group.LogicalId})`)(function* (
        request?: Omit<I, "applicationName" | "deploymentGroupName">,
      ) {
        return yield* op({
          ...request,
          applicationName: yield* ApplicationName,
          deploymentGroupName: yield* DeploymentGroupName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a group-anchored operation whose input
 * addresses deployments by id (get/stop/continue, lifecycle-hook results,
 * deployment targets): the request passes through as-is and the deploy-time
 * half grants `actions` on the deployment-group ARN (CodeDeploy authorizes
 * deployment-addressed operations against the group the deployment belongs
 * to).
 */
export const makeCodeDeployGroupHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodeDeploy.GetDeployment`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the deployment-group ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <G extends DeploymentGroup>(group: G) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${group}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${group.deploymentGroupArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${group.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });

/**
 * Build the impl Effect for an operation whose input carries an
 * `applicationName` field (revision management): the runtime callable
 * injects the bound {@link Application}'s name and the deploy-time half
 * grants `actions` on the application ARN.
 */
export const makeCodeDeployApplicationHttpBinding = <
  I extends { applicationName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodeDeploy.GetApplicationRevision`. */
  tag: string;
  /** The distilled operation; `applicationName` is injected from the app. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the application ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <P extends Application>(application: P) {
      const ApplicationName = yield* application.applicationName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${application}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${application.applicationArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${application.LogicalId})`)(function* (
        request?: Omit<I, "applicationName">,
      ) {
        return yield* op({
          ...request,
          applicationName: yield* ApplicationName,
        } as I);
      });
    });
  });

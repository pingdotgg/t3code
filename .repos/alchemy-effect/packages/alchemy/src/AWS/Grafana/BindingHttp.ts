import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Shared scaffolding for AWS Managed Grafana HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for an account-level operation (e.g. listing the
 * available Grafana versions). The deploy-time half grants `actions` on `*`.
 */
export const makeGrafanaAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Grafana.ListVersions`. */
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

/**
 * Build the impl Effect for a workspace-scoped operation: the runtime
 * callable injects the bound {@link Workspace}'s id as `workspaceId` and the
 * deploy-time half grants `actions` on the workspace ARN.
 */
export const makeGrafanaWorkspaceHttpBinding = <
  I extends { workspaceId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Grafana.ListPermissions`. */
  tag: string;
  /** The distilled operation; `workspaceId` is injected from the workspace. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the workspace ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (workspace: Workspace) {
      const workspaceId = yield* workspace.workspaceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${workspace}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${workspace.workspaceArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${workspace.LogicalId})`)(function* (
        request?: Omit<I, "workspaceId">,
      ) {
        return yield* op({
          ...(request ?? {}),
          workspaceId: yield* workspaceId,
        } as I);
      });
    });
  });

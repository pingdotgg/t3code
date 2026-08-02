import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { QApp } from "./QApp.ts";

/**
 * Shared HTTP scaffolding for the Amazon Q Apps runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate: every Q Apps operation runs against the Q Business
 * application environment instance of the bound {@link QApp} (its
 * `instanceId` is injected as the `instance-id` header), and app-keyed
 * operations additionally inject the bound app's `appId`.
 *
 * Two IAM grant shapes:
 *
 * - {@link makeQAppHttpBinding} — operations keyed by the bound Q App or one
 *   of its sessions. Granted on the app's ARN and its sub-resources
 *   (`{appArn}`, `{appArn}/*` — Q App session ARNs are children of the app
 *   ARN).
 * - {@link makeQAppsInstanceHttpBinding} — instance-level operations
 *   (library items, categories, listing, generation). Library-item and
 *   category authorization ARNs are service-assigned and not derivable from
 *   a bound Q App, so these grant on `Resource: ["*"]`.
 */

/**
 * Build the impl Effect for a Q Apps operation keyed by the bound
 * {@link QApp} (or one of its sessions): the runtime callable injects the
 * app's `instanceId` (and, with `injectAppId`, its `appId`); the deploy-time
 * half grants `iamActions` on the app ARN and its session sub-resources.
 */
export const makeQAppHttpBinding = <
  I extends { instanceId: string },
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"StartQAppSession"`.
   */
  capability: string;
  /** IAM actions granted on the app ARN + `{appArn}/*`. */
  iamActions: readonly string[];
  /** The distilled operation; `instanceId` (and `appId`) are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Inject the bound app's `appId` into the request. */
  injectAppId?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (app: QApp) {
      const instanceId = yield* app.instanceId;
      const appId = yield* app.appId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.QApps.${options.capability}(${app}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [
                    Output.interpolate`${app.appArn}`,
                    Output.interpolate`${app.appArn}/*`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.QApps.${options.capability}(${app.LogicalId})`)(
        function* (request?: Omit<I, "instanceId" | "appId">) {
          const input = options.injectAppId
            ? {
                ...request,
                instanceId: yield* instanceId,
                appId: yield* appId,
              }
            : { ...request, instanceId: yield* instanceId };
          return yield* op(input as I);
        },
      );
    });
  });

/**
 * Build the impl Effect for an instance-level Q Apps operation (library
 * items, categories, listing, generation): the runtime callable injects the
 * bound {@link QApp}'s `instanceId`. Library-item and category authorization
 * ARNs are service-assigned and not derivable from a bound Q App, so the
 * deploy-time half grants `iamActions` on `Resource: ["*"]`.
 */
export const makeQAppsInstanceHttpBinding = <
  I extends { instanceId: string },
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListLibraryItems"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation; `instanceId` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (app: QApp) {
      const instanceId = yield* app.instanceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.QApps.${options.capability}(${app}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.QApps.${options.capability}(${app.LogicalId})`)(
        function* (request?: Omit<I, "instanceId">) {
          return yield* op({ ...request, instanceId: yield* instanceId } as I);
        },
      );
    });
  });

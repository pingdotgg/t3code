import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { App } from "./App.ts";

/**
 * Shared scaffolding for Amplify's app-scoped HTTP bindings. Every Amplify
 * data-plane operation takes the `appId` of the {@link App} it acts on and is
 * authorized by a single `amplify:*` IAM action over an app-derived ARN — this
 * factory captures that shape once so each `{Op}Http.ts` is a thin one-call
 * export.
 *
 * NOT exported from `index.ts` — internal scaffolding only.
 */
export interface AmplifyHttpBindingOptions<
  I extends { appId: string },
  A,
  E,
  R,
> {
  /** Capability name, e.g. `"StartJob"` — used for the bind sid and span name. */
  name: string;
  /** The distilled Amplify operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted to the host, e.g. `["amplify:StartJob"]`. */
  actions: string[];
  /** IAM resource ARNs (derived from the bound app) the actions apply to. */
  resources: (app: App) => Array<string | Output.Output<string>>;
}

/**
 * Build the init Effect of an Amplify app-scoped HTTP binding: resolves the
 * operation once at layer init, grants the IAM statement on the binding host
 * at deploy time, and returns a runtime callable that injects the bound app's
 * `appId` into every request.
 */
export const makeAmplifyHttpBinding = <I extends { appId: string }, A, E, R>(
  options: AmplifyHttpBindingOptions<I, A, E, R>,
) =>
  Effect.gen(function* () {
    const operation = yield* options.operation;

    return Effect.fn(function* (app: App) {
      const AppId = yield* app.appId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Amplify.${options.name}(${app}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: options.actions,
                  Resource: options.resources(app),
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Amplify.${options.name}(${app.LogicalId})`)(
        function* (request: Omit<I, "appId">) {
          // Omit<I, "appId"> + the injected appId reconstructs I; TS cannot
          // prove that for a generic I, hence the assertion.
          return yield* operation({
            ...request,
            appId: yield* AppId,
          } as unknown as I);
        },
      );
    });
  });

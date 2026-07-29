import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Output } from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ConfigRule } from "./ConfigRule.ts";
import type { DeliveryChannel } from "./DeliveryChannel.ts";

/**
 * Shared scaffolding for AWS Config HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in
 * this service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over
 * one of the two builders below. Everything except the operation, the IAM
 * action, and the injected identifier is boilerplate.
 *
 * AWS Config actions do not support resource-level permissions (the service
 * authorization reference lists no resource types for the data-plane
 * read/evaluate actions), so the deploy-time half always grants `actions`
 * on `*`. Resource-scoped bindings still scope the *API call* to the bound
 * resource by injecting its physical identifier into every request.
 */

/** Config resources a resource-scoped binding can be bound to. */
export type BindableConfigResource = ConfigRule | DeliveryChannel;

/**
 * Build the impl Effect for an account-level AWS Config operation. The
 * runtime callable passes the caller's request through unchanged; the
 * deploy-time half grants `actions` on `*`.
 */
export const makeConfigAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Config.SelectResourceConfig`. */
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
 * Build the impl Effect for an operation scoped to a single bound Config
 * resource ({@link ConfigRule} or {@link DeliveryChannel}). The runtime
 * callable injects the resolved `identifier` under `requestKey` (wrapped in
 * a single-element array when `asList` is set, e.g.
 * `StartConfigRulesEvaluation`'s `ConfigRuleNames`); the deploy-time half
 * grants `actions` on `*` (Config actions are not resource-scoped in IAM).
 */
export const makeConfigResourceHttpBinding = <
  Res extends BindableConfigResource,
  K extends string,
  I,
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Config.GetComplianceDetailsByConfigRule`. */
  tag: string;
  /** The distilled operation; the identifier is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
  /** Request field the resolved identifier is injected under. */
  requestKey: K;
  /** Wrap the injected identifier in a single-element array. */
  asList?: boolean;
  /** Resolve the injected identifier from the bound resource. */
  identifier: (resource: Res) => Output<string, never>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (resource: Res) {
      const identifier = yield* options.identifier(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${resource}))`({
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
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        const input: Record<string, unknown> = { ...request };
        const id = yield* identifier;
        input[options.requestKey] = options.asList ? [id] : id;
        return yield* op(input as unknown as I);
      });
    });
  });

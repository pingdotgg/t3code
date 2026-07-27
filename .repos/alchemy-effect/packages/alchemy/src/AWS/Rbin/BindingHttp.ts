import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Rule } from "./Rule.ts";

/**
 * Shared scaffolding for the Recycle Bin (rbin) HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a Recycle Bin operation scoped to a retention
 * {@link Rule}: the deploy-time half grants `actions` on the bound rule's
 * ARN, and the runtime half injects the rule's `Identifier` into every
 * request.
 */
export const makeRbinRuleHttpBinding = <
  I extends { Identifier: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Rbin.GetRule`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the retention rule ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (rule: Rule) {
      const Identifier = yield* rule.identifier;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${rule}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [rule.ruleArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${rule.LogicalId})`)(function* (
        request?: Omit<I, "Identifier">,
      ) {
        const identifier = yield* Identifier;
        return yield* op({ ...request, Identifier: identifier } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Recycle Bin operation
 * (enumerating the Region's retention rules). The deploy-time half grants
 * `actions` on `*` — `rbin:ListRules` is a list action that is not scoped to
 * a single rule resource.
 */
export const makeRbinAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Rbin.ListRules`. */
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
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* op(request);
      });
    });
  });

import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Transformer } from "./Transformer.ts";

/**
 * Shared scaffolding for B2BI HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation, the IAM action list, and
 * the injected identifier is boilerplate.
 */

/**
 * Build the impl Effect for a transformer-scoped operation: the runtime
 * callable injects the bound {@link Transformer}'s ID as `transformerId` and
 * the deploy-time half grants `actions` on the transformer ARN.
 */
export const makeTransformerScopedHttpBinding = <
  I extends { transformerId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.B2BI.StartTransformerJob`. */
  tag: string;
  /** The distilled operation; `transformerId` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the transformer ARN. */
  actions: readonly string[];
  /**
   * Companion statements the operation needs beyond the transformer-scoped
   * b2bi action — B2BI reaches into S3 through the caller's session
   * (forward-access), so e.g. `StartTransformerJob` needs S3 access on the
   * host.
   */
  companionStatements?: readonly PolicyStatement[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (transformer: Transformer) {
      const TransformerId = yield* transformer.transformerId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${transformer}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${transformer.transformerArn}`],
              },
              ...(options.companionStatements ?? []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${transformer.LogicalId})`)(function* (
        request: Omit<I, "transformerId">,
      ) {
        return yield* op({
          ...request,
          transformerId: yield* TransformerId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level operation (no target resource).
 * The deploy-time half grants `actions` on `*` — B2BI's test/generate
 * operations don't support resource-level scoping.
 */
export const makeB2biAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.B2BI.TestMapping`. */
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

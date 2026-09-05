import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Adapter } from "./Adapter.ts";

/**
 * Shared HTTP scaffolding for the Textract runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action is
 * boilerplate.
 *
 * Textract's document analysis actions (sync `Analyze*`/`Detect*` and the
 * async `Start*`/`Get*` job APIs) have no resource-level IAM, so the
 * account-level builder grants on `*`. The adapter management actions
 * authorize on the adapter / adapter-version resource types, which use
 * Textract's nonstandard leading-slash ARN path
 * (`arn:aws:textract:{region}:{account}:/adapters/{adapterId}`), so the
 * adapter-scoped builder grants on the bound adapter's ARN and its
 * `/versions/*` children.
 */
export const makeTextractHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"AnalyzeDocument"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Textract.${options.capability}())`(
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
      return Effect.fn(`AWS.Textract.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for an adapter-scoped Textract operation: the
 * binding is constructed with an {@link Adapter}, the deploy-time half
 * grants `iamActions` on the adapter's ARN (and its `/versions/*`
 * children), and the runtime callable injects the adapter's `AdapterId`
 * into every request.
 */
export const makeTextractAdapterHttpBinding = <
  I extends { AdapterId?: string },
  A,
  E,
  R,
>(options: {
  /** Short capability name, e.g. `"GetAdapter"`. */
  capability: string;
  /** IAM actions granted on the adapter ARN + `/versions/*`. */
  iamActions: readonly string[];
  /** The distilled operation; `AdapterId` is injected from the adapter. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <Ad extends Adapter>(adapter: Ad) {
      const AdapterId = yield* adapter.adapterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Textract.${options.capability}(${adapter}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [
                    Output.interpolate`${adapter.adapterArn}`,
                    Output.interpolate`${adapter.adapterArn}/versions/*`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Textract.${options.capability}(${adapter.LogicalId})`,
      )(function* (request?: Omit<I, "AdapterId">) {
        return yield* op({
          ...(request ?? {}),
          AdapterId: yield* AdapterId,
        } as I);
      });
    });
  });

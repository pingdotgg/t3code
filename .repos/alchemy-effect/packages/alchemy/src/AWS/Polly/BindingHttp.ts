import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared HTTP scaffolding for the Polly runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makePollyHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action is boilerplate.
 *
 * Per the `polly` service authorization reference, only the lexicon
 * management actions (`GetLexicon`, `PutLexicon`, `DeleteLexicon`) support
 * resource-level IAM (the `lexicon` resource type); the synthesis, task,
 * and describe actions authorize on `Resource: ["*"]`, so the account-level
 * builder grants on `*`.
 */
export const makePollyHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"SynthesizeSpeech"`.
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
          yield* host.bind`Allow(${host}, AWS.Polly.${options.capability}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.iamActions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Polly.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

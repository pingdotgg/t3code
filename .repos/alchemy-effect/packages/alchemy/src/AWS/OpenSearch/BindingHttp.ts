import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared scaffolding for AWS OpenSearch Service HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeOpenSearchHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 *
 * The bindings are account-level (the runtime request carries the
 * `DomainName`) rather than domain-scoped: domain names are frequently
 * runtime data — an operator Lambda watches every domain in the account, not
 * one resource-bound domain — and OpenSearch domains take 15-25 minutes to
 * provision, so a deploy-time resource resolution would gate every consumer
 * on a live domain.
 */

/**
 * Build the impl Effect for an OpenSearch configuration-API operation. The
 * deploy-time half grants `actions` on `resources` (default `*` — domain
 * names addressed at runtime are data, so the grant cannot be narrowed to a
 * deploy-time ARN).
 */
export const makeOpenSearchHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.OpenSearch.DescribeDomain`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted. */
  actions: readonly string[];
  /**
   * IAM resources the actions are granted on.
   * @default ["*"]
   */
  resources?: readonly string[];
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
                Resource: [...(options.resources ?? ["*"])],
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

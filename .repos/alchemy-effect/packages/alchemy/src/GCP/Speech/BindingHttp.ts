import * as Effect from "effect/Effect";
import type { CustomClass } from "./CustomClass.ts";
import type { PhraseSet } from "./PhraseSet.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

const makeNamedHttpBinding = <
  Resource extends CustomClass | PhraseSet,
  I,
  A,
  E,
  Req = void,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  toInput: (name: string, request: Req | undefined) => I;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (resource: Resource) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: resource,
        iam: [grantFor(options.iam, resource.name)],
      });
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Req,
      ) {
        const resourceName = yield* name;
        return yield* run(options.toInput(resourceName, request));
      });
    });
  });

/**
 * Shared HTTP scaffolding for Speech-to-Text bindings.
 * NOT exported from index.ts.
 */
export const makeCustomClassHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  toInput: (name: string, request: Req | undefined) => I;
}) => makeNamedHttpBinding<CustomClass, I, A, E, Req>(options);

export const makePhraseSetHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  toInput: (name: string, request: Req | undefined) => I;
}) => makeNamedHttpBinding<PhraseSet, I, A, E, Req>(options);

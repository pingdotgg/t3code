import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { AdaptiveMtDataset } from "./AdaptiveMtDataset.ts";
import type { GlossariesGlossaryEntry } from "./GlossariesGlossaryEntry.ts";
import { locationParentOf } from "./internal.ts";
import type { Model } from "./Model.ts";

const closeOver = <I, A, E>(operation: GcpHttpOp<I, A, E>) => operation;

const makeNamedHttpBinding = <
  Resource extends AdaptiveMtDataset | GlossariesGlossaryEntry | Model,
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* closeOver(options.operation);
    return Effect.fn(function* (resource: Resource) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`({
          iam: [grantFor(options.iam, resource.name)],
        });
      }
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });

const makeLocationParentHttpBinding = <
  Resource extends AdaptiveMtDataset | Model,
  I extends { parent: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  withBody: (name: string, request: Omit<I, "parent"> | undefined) => I;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* closeOver(options.operation);
    return Effect.fn(function* (resource: Resource) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`({
          iam: [grantFor(options.iam, resource.name)],
        });
      }
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "parent">,
      ) {
        return yield* run(options.withBody(yield* name, request));
      });
    });
  });

/**
 * Shared HTTP scaffolding for Cloud Translation bindings.
 * NOT exported from index.ts.
 */
export const makeAdaptiveMtDatasetHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<AdaptiveMtDataset, I, A, E>(options);

export const makeGlossaryEntryHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<GlossariesGlossaryEntry, I, A, E>(options);

export const makeModelHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<Model, I, A, E>(options);

export const makeAdaptiveMtTranslateBinding = <I extends { parent: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  withBody: (name: string, request: Omit<I, "parent"> | undefined) => I;
}) => makeLocationParentHttpBinding<AdaptiveMtDataset, I, A, E>(options);

export const makeTranslateTextBinding = <I extends { parent: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  withBody: (name: string, request: Omit<I, "parent"> | undefined) => I;
}) => makeLocationParentHttpBinding<Model, I, A, E>(options);

export { locationParentOf };

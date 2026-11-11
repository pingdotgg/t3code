import type { GcpOpContext } from "@distilled.cloud/gcp/contentwarehouse_v1";
import type { Output } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam } from "../HttpBinding.ts";
import type { Document } from "./Document.ts";
import type { DocumentSchema } from "./DocumentSchema.ts";
import type { RuleSet } from "./RuleSet.ts";
import type { SynonymSet } from "./SynonymSet.ts";

/**
 * Distilled ops are OperationMethods: yield them once at Layer construction
 * (after providing Credentials + HttpClient) so the inner runtime Effect is
 * `Effect<A, E>` and does not leak `GcpOpContext`.
 */
type GcpHttpOp<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, GcpOpContext> &
  ((input: I) => Effect.Effect<A, E, GcpOpContext>);

const makeNamedHttpBinding = <
  Resource extends { name: Output<string, never>; LogicalId: string },
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
    const run = yield* GCPBindings.withCredentials(options.operation);
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
        const resourceName = yield* name;
        return yield* run({
          ...request,
          name: resourceName,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for Content Warehouse bindings.
 * NOT exported from index.ts.
 */
export const makeDocumentSchemaHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<DocumentSchema, I, A, E>(options);

export const makeDocumentHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<Document, I, A, E>(options);

export const makeRuleSetHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<RuleSet, I, A, E>(options);

export const makeSynonymSetHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<SynonymSet, I, A, E>(options);

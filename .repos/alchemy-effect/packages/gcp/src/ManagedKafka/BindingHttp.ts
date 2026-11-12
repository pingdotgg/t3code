import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { Output } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, grantFor } from "../HttpBinding.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

type NamedResource = {
  readonly name: Output<string, never>;
  readonly LogicalId: string;
};

/**
 * Shared HTTP scaffolding for Managed Kafka named-resource bindings.
 * Distilled ops are OperationMethods: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 * NOT exported from index.ts.
 */
export const makeManagedKafkaHttpBinding =
  <Resource extends NamedResource>() =>
  <I extends { name?: string }, A, E>(options: {
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

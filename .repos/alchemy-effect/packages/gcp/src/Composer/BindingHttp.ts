import type { GcpOpContext } from "@distilled.cloud/gcp/composer_v1";
import type { Output } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, grantFor } from "../HttpBinding.ts";
import type { Environment } from "./Environment.ts";
import type { EnvironmentsUserWorkloadsConfigMap } from "./EnvironmentsUserWorkloadsConfigMap.ts";
import type { EnvironmentsUserWorkloadsSecret } from "./EnvironmentsUserWorkloadsSecret.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, GcpOpContext> &
  ((input: I) => Effect.Effect<A, E, GcpOpContext>);

type NamedResource = {
  readonly name: Output<string, never>;
  readonly LogicalId: string;
};

/**
 * Shared HTTP scaffolding for Cloud Composer bindings whose request
 * identifies the resource by a single name path parameter.
 * Distilled ops are OperationMethods: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 * NOT exported from index.ts.
 */
export const makeNamedHttpBinding = <Resource extends NamedResource, I, A, E>(options: {
  tag: string;
  iam: BindingIam;
  nameKey?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    const nameKey = options.nameKey ?? "name";
    return Effect.fn(function* (resource: Resource) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`({
          iam: [grantFor(options.iam, resource.name)],
        });
      }
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (request?: object) {
        const resourceName = yield* name;
        return yield* run({
          ...request,
          [nameKey]: resourceName,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for Cloud Composer environment bindings.
 * NOT exported from index.ts.
 */
export const makeEnvironmentHttpBinding = <I, A, E>(options: {
  tag: string;
  iam: BindingIam;
  nameKey: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  makeNamedHttpBinding<Environment, I, A, E>({
    tag: options.tag,
    iam: options.iam,
    nameKey: options.nameKey,
    operation: options.operation,
  });

export const makeUserWorkloadsConfigMapHttpBinding = <I, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  makeNamedHttpBinding<EnvironmentsUserWorkloadsConfigMap, I, A, E>({
    tag: options.tag,
    iam: options.iam,
    nameKey: "name",
    operation: options.operation,
  });

export const makeUserWorkloadsSecretHttpBinding = <I, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  makeNamedHttpBinding<EnvironmentsUserWorkloadsSecret, I, A, E>({
    tag: options.tag,
    iam: options.iam,
    nameKey: "name",
    operation: options.operation,
  });

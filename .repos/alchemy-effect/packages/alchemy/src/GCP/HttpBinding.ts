import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Effect from "effect/Effect";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import { bindGcpHost, type GcpIamGrant } from "./Host.ts";
import type { GcpIamResourceKind } from "./IamPolicy.ts";

/**
 * Distilled ops are `OperationMethod`s: yield them once at Layer
 * construction so the inner runtime Effect is `Effect<A, E>` and does
 * not leak `GcpOpContext`. Do not `provideService` Credentials/HttpClient
 * here — the host Layer already provides them.
 */
export type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  GcpOpContext
> &
  ((input: I) => Effect.Effect<A, E, GcpOpContext>);

/**
 * IAM a binding grants the host's runtime service account on the bound
 * resource: `role` is the narrowest predefined role covering the
 * operation. With `on`, the role is granted on the bound resource's own
 * IAM policy (resource-scoped, like an AWS statement's `Resource: [arn]`);
 * without it — only for services that have no resource-level IAM — the
 * role is granted on the project.
 */
export interface BindingIam {
  role: string;
  on?: Exclude<GcpIamResourceKind, "project">;
  /**
   * For services with no per-resource IAM policy but IAM Conditions
   * support (Firestore, Cloud SQL, Managed Kafka): grant on the project
   * under a condition matching only the bound resource and its children.
   */
  scopeByCondition?: boolean;
}

const nameExpression = (value: string) =>
  `resource.name == "${value}" || resource.name.startsWith("${value}/")`;

/** IAM Condition matching one resource (by full name) and its children. */
export const resourceNameCondition = (name: Input<string>) => ({
  title: "alchemy-scoped",
  expression:
    typeof name === "string"
      ? nameExpression(name)
      : Output.map(name as Output.Output<string>, nameExpression),
});

/** Build the grant for `iam` against a bound resource's full name. */
export const grantFor = (
  iam: BindingIam,
  name: Input<string>,
): Input<GcpIamGrant> =>
  iam.on !== undefined
    ? // The engine resolves the name Output before the host reconciles.
      { role: iam.role, resource: { kind: iam.on, name } }
    : iam.scopeByCondition
      ? { role: iam.role, condition: resourceNameCondition(name) }
      : { role: iam.role };

/**
 * Shared HTTP scaffolding for GCP named-resource bindings.
 *
 * Yields the distilled operation (no double-provide) and, at deploy
 * time, grants `iam` on the ambient Cloud Run / Function host the way
 * AWS bindings attach IAM policy statements.
 */
export const makeNamedHttpBinding = <
  Resource extends { LogicalId: string },
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  iam: BindingIam;
  resourceName: (resource: Resource) => Output.Output<string, never>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (resource: Resource) {
      const resourceName = options.resourceName(resource);
      yield* bindGcpHost({
        tag: options.tag,
        resource,
        iam: [grantFor(options.iam, resourceName)],
      });
      const name = yield* resourceName;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request ?? {}),
          name: yield* name,
        } as I);
      });
    });
  });

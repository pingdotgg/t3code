import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import type { Instance } from "./Instance.ts";
import type { User } from "./User.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Cloud SQL instance and user bindings.
 * Distilled ops are OperationMethods: yield them once at Layer
 * construction so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 * NOT exported from index.ts.
 */
export const makeSqlInstanceHttpBinding = <
  I extends { instance?: string; project?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (instance: Instance) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: instance,
        iam: [
          grantFor(
            options.iam,
            Output.interpolate`projects/${instance.project}/instances/${instance.instanceName}`,
          ),
        ],
      });
      const instanceName = yield* instance.instanceName;
      const project = yield* instance.project;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "instance" | "project">,
      ) {
        return yield* run({
          ...(request ?? {}),
          instance: yield* instanceName,
          project: yield* project,
        } as I);
      });
    });
  });

export const makeSqlUserHttpBinding = <
  I extends {
    name?: string;
    instance?: string;
    project?: string;
    host?: string;
  },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (user: User) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: user,
        iam: [
          grantFor(
            options.iam,
            Output.interpolate`projects/${user.project}/instances/${user.instance}`,
          ),
        ],
      });
      const userName = yield* user.userName;
      const instance = yield* user.instance;
      const project = yield* user.project;
      const host = yield* user.host;
      return Effect.fn(`${options.tag}(${user.LogicalId})`)(function* (
        request?: Omit<I, "name" | "instance" | "project">,
      ) {
        const resolvedHost = request?.host ?? (yield* host);
        return yield* run({
          ...(request ?? {}),
          name: yield* userName,
          instance: yield* instance,
          project: yield* project,
          ...(resolvedHost ? { host: resolvedHost } : {}),
        } as I);
      });
    });
  });

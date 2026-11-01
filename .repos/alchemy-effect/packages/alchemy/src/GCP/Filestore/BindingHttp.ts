import * as Effect from "effect/Effect";
import type { Backup } from "./Backup.ts";
import type { Instance } from "./Instance.ts";
import type { InstancesSnapshot } from "./InstancesSnapshot.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Filestore instance, backup, and snapshot
 * bindings. NOT exported from index.ts.
 */
export const makeFilestoreInstanceHttpBinding = <
  I extends { name?: string },
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
        iam: [grantFor(options.iam, instance.name)],
      });
      const name = yield* instance.name;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeFilestoreBackupHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (backup: Backup) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: backup,
        iam: [grantFor(options.iam, backup.name)],
      });
      const name = yield* backup.name;
      return Effect.fn(`${options.tag}(${backup.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeFilestoreSnapshotHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (snapshot: InstancesSnapshot) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: snapshot,
        iam: [grantFor(options.iam, snapshot.name)],
      });
      const name = yield* snapshot.name;
      return Effect.fn(`${options.tag}(${snapshot.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

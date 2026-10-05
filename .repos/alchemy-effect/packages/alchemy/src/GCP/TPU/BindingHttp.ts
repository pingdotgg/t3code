import * as Effect from "effect/Effect";
import type { Node } from "./Node.ts";
import type { QueuedResource } from "./QueuedResource.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Cloud TPU node bindings.
 * NOT exported from index.ts.
 */
export const makeTpuNodeHttpBinding = <
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
    return Effect.fn(function* (node: Node) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: node,
        iam: [grantFor(options.iam, node.name)],
      });
      const name = yield* node.name;
      return Effect.fn(`${options.tag}(${node.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for Cloud TPU queued resource bindings.
 * NOT exported from index.ts.
 */
export const makeTpuQueuedResourceHttpBinding = <
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
    return Effect.fn(function* (resource: QueuedResource) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: resource,
        iam: [grantFor(options.iam, resource.name)],
      });
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

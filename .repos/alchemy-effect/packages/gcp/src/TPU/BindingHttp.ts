import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Node } from "./Node.ts";
import type { QueuedResource } from "./QueuedResource.ts";

/**
 * Shared HTTP scaffolding for Cloud TPU node bindings.
 * NOT exported from index.ts.
 */
export const makeTpuNodeHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (node: Node) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${node})`({
          iam: [grantFor(options.iam, node.name)],
        });
      }
      const name = yield* node.name;
      return Effect.fn(`${options.tag}(${node.LogicalId})`)(function* (request?: Omit<I, "name">) {
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
export const makeTpuQueuedResourceHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (resource: QueuedResource) {
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
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

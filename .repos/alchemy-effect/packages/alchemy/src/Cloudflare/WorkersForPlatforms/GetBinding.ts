/// <reference types="@cloudflare/workers-types" />

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { DispatchNamespace as DispatchNamespaceResource } from "./DispatchNamespace.ts";
import {
  type DispatchNamespaceClient,
  DispatchNamespaceError,
  Get,
} from "./Get.ts";

/**
 * Implementation of the {@link Get} binding that uses a native
 * `dispatch_namespace` Worker binding.
 */
export const GetBinding = Layer.effect(
  Get,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (namespace: DispatchNamespaceResource) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${namespace}`({
          bindings: [
            {
              type: "dispatch_namespace",
              name: namespace.LogicalId,
              namespace: namespace.name,
            },
          ],
        });
      }

      const raw = Effect.sync(
        // Lazy — the WorkerEnvironment binding is not populated until runtime.
        () => (env as Record<string, DispatchNamespace>)[namespace.LogicalId]!,
      );

      const self: DispatchNamespaceClient = {
        raw,
        get: (name, args, options) =>
          raw.pipe(
            Effect.flatMap((ns) =>
              Effect.try({
                try: () => ns.get(name, args, options),
                catch: (error) =>
                  new DispatchNamespaceError({
                    message:
                      error instanceof Error
                        ? error.message
                        : "Unknown dispatch namespace runtime error",
                    cause: error,
                  }),
              }),
            ),
          ),
      };
      return self;
    });
  }),
);

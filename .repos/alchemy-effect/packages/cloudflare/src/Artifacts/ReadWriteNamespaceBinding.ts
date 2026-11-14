import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { type Namespace as ArtifactsLike } from "./Namespace.ts";
import { makeArtifactsNamespaceClient } from "./NamespaceBinding.ts";
import { ReadNamespace, ReadWriteNamespace, WriteNamespace } from "./ReadWriteNamespace.ts";

const makeBinding = <Self>(tag: Self) =>
  Layer.effect(
    tag as any,
    Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      const host = yield* Worker;
      return Effect.fn(function* (namespace: ArtifactsLike) {
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          yield* host.bind(namespace.name, {
            bindings: [
              {
                type: "artifacts",
                name: namespace.name,
                namespace: namespace.namespace,
              } as any,
            ],
          });
        }
        return makeArtifactsNamespaceClient(env, namespace);
      });
    }),
  ) as Layer.Layer<Self, never, Worker | WorkerEnvironment>;

/** Read-only Artifacts binding (`get`/`list`/`raw`; repos expose history and file reads). */
export const ReadNamespaceBinding = makeBinding(ReadNamespace);
/** Write Artifacts binding (`create`/`delete`/`import`). */
export const WriteNamespaceBinding = makeBinding(WriteNamespace);
/** Full read + write Artifacts binding. */
export const ReadWriteNamespaceBinding = makeBinding(ReadWriteNamespace);

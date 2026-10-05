import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const Trainer = GCP.TPU.Node("Trainer", {
  location: "us-central1-c",
  acceleratorType: "v2-8",
  runtimeVersion: "tpu-ubuntu2204-base",
});

export const QueuedTrainer = GCP.TPU.QueuedResource("QueuedTrainer", {
  location: "us-central1-c",
  nodeSpec: [
    {
      node: {
        acceleratorType: "v2-8",
        runtimeVersion: "tpu-ubuntu2204-base",
      },
    },
  ],
});

/**
 * Effect-native Cloud Run service exercising every Cloud TPU binding as
 * its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class TpuBindingsHost extends GCP.Function<TpuBindingsHost>()(
  "TpuBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getNode = yield* GCP.TPU.GetNode(Trainer);
    const getQueuedResource = yield* GCP.TPU.GetQueuedResource(QueuedTrainer);

    return {
      fetch: serveProbes({
        getNode: getNode().pipe(
          Effect.map((node) => ({
            name: node.name,
            acceleratorType: node.acceleratorType,
          })),
        ),
        getQueuedResource: getQueuedResource().pipe(
          Effect.map((resource) => ({ name: resource.name })),
        ),
      }),
    };
  }).pipe(
    Effect.provide(GCP.TPU.GetNodeHttp),
    Effect.provide(GCP.TPU.GetQueuedResourceHttp),
  ),
) {}

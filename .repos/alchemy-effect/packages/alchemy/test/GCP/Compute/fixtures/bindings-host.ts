import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { serveProbes } from "../../bindingHost.ts";
import { DEFAULT_NETWORK, defaultNetworkSelfLink } from "../../networkQuota.ts";

/**
 * Smallest VM the bindings act on. It sits on the project's `default`
 * network, so it takes no VPC quota slot.
 */
export const Vm = Effect.gen(function* () {
  // GcpEnvironment exists at deploy time only; the deployed host never
  // reconciles props, so the relative form is an equivalent stand-in there.
  const env = yield* Effect.serviceOption(GcpEnvironment);
  const relative = `global/networks/${DEFAULT_NETWORK}`;
  const network = Option.isSome(env)
    ? yield* env.value.pipe(
        Effect.map(({ project }) => defaultNetworkSelfLink(project)),
        Effect.catchTag("GCP.ProjectMissing", () => Effect.succeed(relative)),
      )
    : relative;
  return yield* GCP.Compute.Instance("Vm", {
    zone: "us-central1-a",
    machineType: "e2-micro",
    network,
    associatePublicIp: false,
  });
});

/**
 * Effect-native Cloud Run service exercising every Compute instance binding
 * as its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class ComputeBindingsHost extends GCP.Function<ComputeBindingsHost>()(
  "ComputeBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const vm = yield* Vm;
    const getInstance = yield* GCP.Compute.GetInstance(vm);
    const stopInstance = yield* GCP.Compute.StopInstance(vm);
    const startInstance = yield* GCP.Compute.StartInstance(vm);

    return {
      fetch: serveProbes({
        getInstance: getInstance().pipe(
          Effect.map((live) => ({
            name: live.name,
            id: live.id,
            status: live.status,
          })),
        ),
        stopInstance: stopInstance().pipe(
          Effect.map((op) => ({
            operationType: op.operationType,
            targetLink: op.targetLink,
          })),
        ),
        startInstance: startInstance().pipe(
          Effect.map((op) => ({
            operationType: op.operationType,
            targetLink: op.targetLink,
          })),
        ),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Compute.GetInstanceHttp),
    Effect.provide(GCP.Compute.StopInstanceHttp),
    Effect.provide(GCP.Compute.StartInstanceHttp),
  ),
) {}

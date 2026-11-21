import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { PluginKernel, layer, type PluginServiceContribution } from "@t3tools/shared/pluginKernel";

const runtimeKey = Symbol.for("t3.client.pluginKernelRuntime");
const host = globalThis as typeof globalThis & {
  [runtimeKey]?: ManagedRuntime.ManagedRuntime<PluginKernel, never>;
};
const kernelRuntime = (host[runtimeKey] ??= ManagedRuntime.make(layer));

/** Platform and connection factories share the same client-owned plugin host. */
export const clientPluginKernelLayer = Layer.effectContext(kernelRuntime.contextEffect);

export const clientPluginServices = {
  stage: (
    id: string,
    contributions: readonly PluginServiceContribution[],
    retain?: Effect.Effect<Effect.Effect<void>>,
    namespace?: string,
    options?: Effect.RunOptions,
  ) =>
    kernelRuntime.runPromise(
      Effect.flatMap(PluginKernel, (kernel) =>
        kernel.stage(id, contributions, retain, namespace),
      ).pipe(Effect.timeout("10 seconds")),
      options,
    ),
  setEnabled: (id: string, enabled: boolean, scope = "host") =>
    kernelRuntime.runPromise(
      Effect.flatMap(PluginKernel, (kernel) => kernel.setEnabled(id, enabled, scope)),
    ),
  list: (scope?: string) =>
    kernelRuntime.runPromise(Effect.map(PluginKernel, (kernel) => kernel.list(scope))),
  get: (key: string, scope?: string) =>
    kernelRuntime.runPromise(Effect.map(PluginKernel, (kernel) => kernel.get(key, scope))),
  getBuiltin: (key: string, scope?: string) =>
    kernelRuntime.runPromise(Effect.map(PluginKernel, (kernel) => kernel.getBuiltin(key, scope))),
};

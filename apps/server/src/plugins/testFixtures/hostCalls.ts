import { PluginManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { PluginRegistration } from "../PluginManifestLoader.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

export const registrationFor = (
  id: string,
  capabilities: ReadonlyArray<string> = ["status"],
): PluginRegistration => ({
  manifest: decodeManifest({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    apiVersion: 1,
    entry: "main.mjs",
    proposedApi: true,
    capabilities,
  }),
  directory: "/plugins/x",
  entryPath: "/plugins/x/main.mjs",
});

/** A supervisor that only records the host methods served through it. */
export const recordingSupervisor = () => {
  const methods = new Map<string, PluginSupervisor.PluginHostMethod>();
  const supervisor = PluginSupervisor.PluginSupervisor.of({
    enable: Effect.fn("TestPluginHost.enable")(() => Effect.void),
    disable: Effect.fn("TestPluginHost.disable")(() => Effect.void),
    resume: Effect.fn("TestPluginHost.resume")(() => Effect.void),
    invoke: Effect.fn("TestPluginHost.invoke")(() => Effect.succeed(null)),
    state: Effect.fn("TestPluginHost.state")(() => Effect.succeedNone),
    subscribe: Effect.die("unused"),
    serveHostMethod: Effect.fn("TestPluginHost.serveHostMethod")(
      (method: string, handler: PluginSupervisor.PluginHostMethod) =>
        Effect.sync(() => void methods.set(method, handler)),
    ),
  });
  /** Calls `method` as the plugin process whose lifetime is `lifetime` would. */
  const call = (
    method: string,
    registration: PluginRegistration,
    lifetime: Scope.Scope,
    input: Schema.Json,
  ) => {
    const handler = methods.get(method);
    if (handler === undefined) return Effect.die(`no host method ${method}`);
    return handler({ registration, input, admitted: Effect.void, lifetime });
  };
  return { supervisor, call };
};

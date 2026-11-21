import { BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS } from "../../../provider/builtInDrivers.ts";
import type { CompiledServerBuiltinDefinition } from "./types.ts";

export const definitions: ReadonlyArray<CompiledServerBuiltinDefinition> = [
  { id: "t3.providers" },
  ...BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS.map(
    ({ id, driver }) =>
      ({
        id,
        manifest: {
          id,
          name: driver.metadata.displayName,
          apiVersion: 1 as const,
          version: "1.0.0",
          permissions: ["server:providers"],
        },
        activate: (host) => host.providers.register(driver),
      }) satisfies CompiledServerBuiltinDefinition,
  ),
];

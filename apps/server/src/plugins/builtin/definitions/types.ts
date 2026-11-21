import type { PluginManifest } from "@t3tools/contracts";
import type { ServerPluginDefinition } from "../../PluginService.ts";

/** Layer-backed services already activate through their scoped kernel factories. */
export interface CompiledServerBuiltinDefinition {
  readonly id: string;
  readonly manifest?: PluginManifest;
  readonly activate?: ServerPluginDefinition["activate"];
}

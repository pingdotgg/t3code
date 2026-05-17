import * as Schema from "effect/Schema";

import { AcpRegistryDocument, type AcpRegistryEntry } from "../acpRegistry.ts";
import registryJson from "./registry.json" with { type: "json" };

const document = Schema.decodeUnknownSync(AcpRegistryDocument)(registryJson);

export const ACP_REGISTRY: ReadonlyArray<AcpRegistryEntry> = document.agents;

export const ACP_REGISTRY_BY_ID: ReadonlyMap<string, AcpRegistryEntry> = new Map(
  ACP_REGISTRY.map((entry) => [entry.id, entry] as const),
);

export const ACP_REGISTRY_VERSION = document.version;

export const acpRegistryEntryById = (id: string): AcpRegistryEntry | undefined =>
  ACP_REGISTRY_BY_ID.get(id);

import { KeybindingsConfig } from "../../packages/contracts/src/keybindings.ts";
import { buildJsonSchemaDocument, writeJsonSchemaArtifacts } from "./json-schema";

export const KEYBINDINGS_SCHEMA_RELATIVE_PATH = "apps/marketing/public/schemas/keybindings.json";
export const KEYBINDINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH =
  "apps/marketing/public/schemas/keybindings";

export const getVersionedKeybindingsSchemaRelativePath = (version: string) =>
  `${KEYBINDINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH}/${version}.json`;

export function buildKeybindingsJsonSchema(): Record<string, unknown> {
  return buildJsonSchemaDocument(KeybindingsConfig, {
    title: "T3 Code Keybindings",
    description: "JSON Schema for the keybindings.json file consumed by T3 Code.",
  });
}

export function writeKeybindingsJsonSchemas(options?: {
  readonly rootDir?: string;
  readonly version?: string;
}): {
  readonly changed: boolean;
} {
  return writeJsonSchemaArtifacts({
    latestRelativePath: KEYBINDINGS_SCHEMA_RELATIVE_PATH,
    getVersionedRelativePath: getVersionedKeybindingsSchemaRelativePath,
    document: buildKeybindingsJsonSchema(),
    ...(options?.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options?.version === undefined ? {} : { version: options.version }),
  });
}

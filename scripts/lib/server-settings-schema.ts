import { ServerSettings } from "@t3tools/contracts/settings";
import { buildJsonSchemaDocument, writeJsonSchemaArtifacts } from "./json-schema";

export const SERVER_SETTINGS_SCHEMA_RELATIVE_PATH = "apps/marketing/public/schemas/settings.json";
export const SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH =
  "apps/marketing/public/schemas/settings";

export const getVersionedServerSettingsSchemaRelativePath = (version: string) =>
  `${SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH}/${version}.json`;

export function buildServerSettingsJsonSchema(): Record<string, unknown> {
  const schema = buildJsonSchemaDocument(ServerSettings, {
    title: "T3 Code Server Settings",
    description: "JSON Schema for the server-authoritative settings.json file consumed by T3 Code.",
  });

  const properties =
    schema.type === "object" &&
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : null;

  if (!properties) {
    throw new Error("ServerSettings JSON schema must expose object properties.");
  }

  return {
    ...schema,
    properties: {
      $schema: {
        type: "string",
        description:
          "Optional JSON Schema reference for editor tooling. May point to the stable or versioned T3 Code settings schema URL.",
      },
      ...properties,
    },
  };
}

export function writeServerSettingsJsonSchemas(options?: {
  readonly rootDir?: string;
  readonly version?: string;
}): {
  readonly changed: boolean;
} {
  return writeJsonSchemaArtifacts({
    latestRelativePath: SERVER_SETTINGS_SCHEMA_RELATIVE_PATH,
    getVersionedRelativePath: getVersionedServerSettingsSchemaRelativePath,
    document: buildServerSettingsJsonSchema(),
    ...(options?.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options?.version === undefined ? {} : { version: options.version }),
  });
}

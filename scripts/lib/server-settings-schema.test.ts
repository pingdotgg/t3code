import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildServerSettingsJsonSchema,
  getVersionedServerSettingsSchemaRelativePath,
  SERVER_SETTINGS_SCHEMA_RELATIVE_PATH,
  writeServerSettingsJsonSchemas,
} from "./server-settings-schema";

describe("buildServerSettingsJsonSchema", () => {
  it("builds a JSON schema document for settings.json", () => {
    const schema = buildServerSettingsJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("T3 Code Server Settings");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toMatchObject({
      $schema: {
        type: "string",
      },
      enableAssistantStreaming: {
        description: "Show token-by-token output while a response is in progress.",
      },
      defaultThreadEnvMode: {
        description: "Pick the default workspace mode for newly created draft threads.",
      },
      textGenerationModelSelection: {
        description:
          "Configure the model used for generated commit messages, PR titles, and similar Git text.",
      },
      providers: {
        description: expect.stringContaining("Provider-specific"),
      },
    });
  });

  it("writes latest and versioned schema files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "t3-server-settings-schema-"));

    try {
      const result = writeServerSettingsJsonSchemas({ rootDir, version: "1.2.3" });
      expect(result.changed).toBe(true);

      const latestSchema = JSON.parse(
        readFileSync(resolve(rootDir, SERVER_SETTINGS_SCHEMA_RELATIVE_PATH), "utf8"),
      ) as Record<string, unknown>;
      const versionedSchema = JSON.parse(
        readFileSync(
          resolve(rootDir, getVersionedServerSettingsSchemaRelativePath("1.2.3")),
          "utf8",
        ),
      ) as Record<string, unknown>;

      expect(latestSchema).toEqual(versionedSchema);
      expect(latestSchema.title).toBe("T3 Code Server Settings");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("skips writing a versioned schema file when the latest schema is unchanged", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "t3-server-settings-schema-"));

    try {
      const latestOnly = writeServerSettingsJsonSchemas({ rootDir });
      expect(latestOnly.changed).toBe(true);

      const result = writeServerSettingsJsonSchemas({ rootDir, version: "1.2.3" });
      expect(result.changed).toBe(false);
      expect(
        existsSync(resolve(rootDir, getVersionedServerSettingsSchemaRelativePath("1.2.3"))),
      ).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

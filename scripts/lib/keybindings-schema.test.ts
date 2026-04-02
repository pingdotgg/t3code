import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildKeybindingsJsonSchema,
  getVersionedKeybindingsSchemaRelativePath,
  KEYBINDINGS_SCHEMA_RELATIVE_PATH,
  writeKeybindingsJsonSchemas,
} from "./keybindings-schema";

describe("buildKeybindingsJsonSchema", () => {
  it("builds a JSON schema document for keybindings.json", () => {
    const schema = buildKeybindingsJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("T3 Code Keybindings");
    expect(schema.type).toBe("array");
    expect(schema.items).toMatchObject({
      description: expect.stringContaining("keybinding rule"),
      type: "object",
      properties: {
        key: {
          description: expect.stringContaining("shortcut"),
        },
        command: {
          description: expect.stringContaining("execute"),
        },
        when: {
          description: expect.stringContaining("active"),
        },
      },
    });
  });

  it("writes latest and versioned schema files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "t3-keybindings-schema-"));

    try {
      const result = writeKeybindingsJsonSchemas({ rootDir, version: "1.2.3" });
      expect(result.changed).toBe(true);

      const latestSchema = JSON.parse(
        readFileSync(resolve(rootDir, KEYBINDINGS_SCHEMA_RELATIVE_PATH), "utf8"),
      ) as Record<string, unknown>;
      const versionedSchema = JSON.parse(
        readFileSync(resolve(rootDir, getVersionedKeybindingsSchemaRelativePath("1.2.3")), "utf8"),
      ) as Record<string, unknown>;

      expect(latestSchema).toEqual(versionedSchema);
      expect(latestSchema.title).toBe("T3 Code Keybindings");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("skips writing a versioned schema file when the latest schema is unchanged", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "t3-keybindings-schema-"));

    try {
      const latestOnly = writeKeybindingsJsonSchemas({ rootDir });
      expect(latestOnly.changed).toBe(true);

      const result = writeKeybindingsJsonSchemas({ rootDir, version: "1.2.3" });
      expect(result.changed).toBe(false);
      expect(existsSync(resolve(rootDir, getVersionedKeybindingsSchemaRelativePath("1.2.3")))).toBe(
        false,
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

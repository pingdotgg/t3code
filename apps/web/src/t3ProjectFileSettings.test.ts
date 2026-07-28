import { T3_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFile,
  createEmptyT3ProjectFileScriptDraft,
  createT3ProjectFileDraft,
} from "./t3ProjectFileSettings";

describe("t3 project file settings", () => {
  it("creates an editable draft from the existing schema fields", () => {
    expect(
      createT3ProjectFileDraft({
        $schema: T3_PROJECT_FILE_SCHEMA_URL,
        iconPath: "assets/icon.svg",
        scripts: [
          {
            name: "Dev",
            command: "vp run dev",
            previewUrl: "http://localhost:5733",
            autoOpenPreview: true,
          },
        ],
      }),
    ).toEqual({
      schemaUrl: T3_PROJECT_FILE_SCHEMA_URL,
      iconPath: "assets/icon.svg",
      scripts: [
        {
          id: "file-0",
          name: "Dev",
          command: "vp run dev",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://localhost:5733",
          autoOpenPreview: true,
        },
      ],
    });
  });

  it("serializes only the supported t3.json fields", () => {
    const result = buildT3ProjectFile({
      schemaUrl: T3_PROJECT_FILE_SCHEMA_URL,
      iconPath: " assets/icon.svg ",
      scripts: [
        {
          id: "setup",
          name: " Setup ",
          command: " vp install ",
          icon: "configure",
          runOnWorktreeCreate: true,
          previewUrl: "",
          autoOpenPreview: true,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toEqual({
      $schema: T3_PROJECT_FILE_SCHEMA_URL,
      iconPath: "assets/icon.svg",
      scripts: [
        {
          name: "Setup",
          command: "vp install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    });
    expect(JSON.parse(result.contents)).toEqual(result.file);
    expect(result.contents.endsWith("\n")).toBe(true);
  });

  it("omits a cleared icon path", () => {
    const result = buildT3ProjectFile({
      schemaUrl: "",
      iconPath: " ",
      scripts: [],
    });

    expect(result).toMatchObject({
      ok: true,
      file: {
        $schema: T3_PROJECT_FILE_SCHEMA_URL,
        scripts: [],
      },
    });
    if (result.ok) {
      expect("iconPath" in result.file).toBe(false);
    }
  });

  it("rejects incomplete shared actions before writing the file", () => {
    expect(
      buildT3ProjectFile({
        schemaUrl: T3_PROJECT_FILE_SCHEMA_URL,
        iconPath: "",
        scripts: [createEmptyT3ProjectFileScriptDraft()],
      }),
    ).toEqual({
      ok: false,
      error: "Shared action 1 needs a name.",
    });
  });
});

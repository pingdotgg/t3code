import { PROJECT_CONFIG_SCHEMA_URL, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { updateProjectConfigJson } from "./projectConfigFile";

const devScript: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "pnpm dev",
  icon: "play",
  runOnWorktreeCreate: false,
  pinnedToTopBar: true,
};

describe("updateProjectConfigJson", () => {
  it("writes scripts and normalized project preview URLs", () => {
    const parsed = JSON.parse(
      updateProjectConfigJson("", {
        scripts: [devScript],
        browserPreviewUrl: ":5173",
      }),
    ) as Record<string, unknown>;

    expect(parsed).toEqual({
      $schema: PROJECT_CONFIG_SCHEMA_URL,
      browser: { previewUrl: "http://localhost:5173" },
      scripts: [devScript],
    });
  });

  it("preserves unrelated config keys while updating browser preview URL", () => {
    const parsed = JSON.parse(
      updateProjectConfigJson(
        JSON.stringify({
          $schema: "https://example.test/project.schema.json",
          browser: { openInBackground: true },
          theme: "dark",
        }),
        {
          browserPreviewUrl: "localhost:3001",
        },
      ),
    ) as Record<string, unknown>;

    expect(parsed).toEqual({
      $schema: "https://example.test/project.schema.json",
      browser: {
        openInBackground: true,
        previewUrl: "http://localhost:3001",
      },
      theme: "dark",
    });
  });

  it("removes browser preview URL when cleared", () => {
    const parsed = JSON.parse(
      updateProjectConfigJson(
        JSON.stringify({
          browser: { previewUrl: "http://localhost:3000/" },
          scripts: [devScript],
        }),
        {
          browserPreviewUrl: "",
        },
      ),
    ) as Record<string, unknown>;

    expect(parsed).toEqual({
      $schema: PROJECT_CONFIG_SCHEMA_URL,
      scripts: [devScript],
    });
  });

  it("rejects invalid project config JSON roots", () => {
    expect(() => updateProjectConfigJson("[]", { scripts: [] })).toThrow(
      "Project config must be a JSON object.",
    );
  });
});

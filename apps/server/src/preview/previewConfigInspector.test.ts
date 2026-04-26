import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectPreviewConfig } from "./previewConfigInspector.ts";

describe("inspectPreviewConfig", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("parses a preview config via the server-scoped TypeScript runtime", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "forma-preview-config-"));
    tempDirectories.push(tempDirectory);
    const configPath = path.join(tempDirectory, "forma.preview.ts");

    await writeFile(
      configPath,
      [
        'import { defineFormaPreviewConfig } from "@forma/preview-react";',
        "",
        "export default defineFormaPreviewConfig({",
        '  appRoot: "apps/web",',
        "  server: {",
        '    command: ["bun", "run", "dev"],',
        '    cwd: "apps/web",',
        '    env: { NODE_ENV: "development" },',
        "  },",
        "  scan: {",
        '    include: ["src/**/*.preview.tsx"],',
        '    exclude: ["src/**/__tests__/*.preview.tsx"],',
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    await expect(inspectPreviewConfig(configPath)).resolves.toEqual({
      appRoot: "apps/web",
      server: {
        command: ["bun", "run", "dev"],
        cwd: "apps/web",
        env: {
          NODE_ENV: "development",
        },
      },
      scan: {
        include: ["src/**/*.preview.tsx"],
        exclude: ["src/**/__tests__/*.preview.tsx"],
      },
    });
  });

  it("treats omitted optional fields as undefined instead of crashing", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "forma-preview-config-"));
    tempDirectories.push(tempDirectory);
    const configPath = path.join(tempDirectory, "forma.preview.ts");

    await writeFile(
      configPath,
      [
        'import { defineFormaPreviewConfig } from "@forma/preview-react";',
        "",
        "export default defineFormaPreviewConfig({",
        '  appRoot: "apps/web",',
        "  server: {",
        '    command: ["bun", "run", "dev"],',
        '    cwd: "apps/web",',
        "  },",
        "  scan: {",
        '    include: ["src/**/*.preview.tsx"],',
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    await expect(inspectPreviewConfig(configPath)).resolves.toEqual({
      appRoot: "apps/web",
      server: {
        command: ["bun", "run", "dev"],
        cwd: "apps/web",
      },
      scan: {
        include: ["src/**/*.preview.tsx"],
        exclude: undefined,
      },
    });
  });
});

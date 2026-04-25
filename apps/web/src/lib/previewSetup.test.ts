import { describe, expect, it } from "vitest";

import { __test__ } from "./previewSetup";

describe("selectPreferredViteConfigPath", () => {
  it("prefers the shallowest vite config candidate", () => {
    expect(
      __test__.selectPreferredViteConfigPath([
        {
          path: "apps/web/vite.config.ts",
          kind: "file",
          parentPath: "apps/web",
        },
        {
          path: "vite.config.ts",
          kind: "file",
        },
      ]),
    ).toBe("vite.config.ts");
  });
});

describe("buildPreviewSetupContents", () => {
  it("includes the configured app root and command", () => {
    expect(
      __test__.buildPreviewSetupContents({
        appRoot: "apps/web",
        launchCwd: ".",
        command: ["bun", "run", "dev"],
      }),
    ).toContain('appRoot: "apps/web"');
    expect(
      __test__.buildPreviewSetupContents({
        appRoot: "apps/web",
        launchCwd: ".",
        command: ["bun", "run", "dev"],
      }),
    ).toContain('command: ["bun", "run", "dev"]');
    expect(
      __test__.buildPreviewSetupContents({
        appRoot: "apps/web",
        launchCwd: ".",
        command: ["bun", "run", "dev"],
      }),
    ).toContain('cwd: "."');
  });
});

describe("buildStarterViteConfig", () => {
  it("references the preview config relative to the vite config", () => {
    expect(
      __test__.buildStarterViteConfig({
        viteConfigPath: "apps/web/vite.config.ts",
        previewConfigPath: "forma.preview.ts",
      }),
    ).toContain('import previewConfig from "../../forma.preview.ts";');
    expect(
      __test__.buildStarterViteConfig({
        viteConfigPath: "apps/web/vite.config.ts",
        previewConfigPath: "forma.preview.ts",
      }),
    ).toContain("formaPreviewVitePlugin(previewConfig, { configPath: previewConfigPath })");
  });
});

describe("patchExistingViteConfig", () => {
  it("injects the preview plugin into an existing plugins array", () => {
    const patched = __test__.patchExistingViteConfig({
      contents: [
        'import react from "@vitejs/plugin-react";',
        'import { defineConfig } from "vite";',
        "",
        "export default defineConfig({",
        "  plugins: [react()],",
        "});",
        "",
      ].join("\n"),
      viteConfigPath: "apps/web/vite.config.ts",
      previewConfigPath: "forma.preview.ts",
    });

    expect(patched.changed).toBe(true);
    expect(patched.note).toBeNull();
    expect(patched.contents).toContain(
      'import { formaPreviewVitePlugin } from "@forma/preview-react-vite";',
    );
    expect(patched.contents).toContain('import previewConfig from "../../forma.preview.ts";');
    expect(patched.contents).toContain(
      "formaPreviewVitePlugin(previewConfig, { configPath: previewConfigPath })",
    );
  });
});

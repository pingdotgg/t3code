import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPreviewRuntimeCacheDir,
  buildPreviewRuntimeWarmupPlan,
  parsePreviewComponentRelativePath,
} from "./previewRuntimeWarmup.ts";

describe("preview runtime warmup", () => {
  it("builds deterministic cache dirs per project workspace", () => {
    const first = buildPreviewRuntimeCacheDir({
      projectRoot: "/repo",
      workspaceRoot: "/repo/apps/web",
    });
    const second = buildPreviewRuntimeCacheDir({
      projectRoot: "/repo",
      workspaceRoot: "/repo/apps/web",
    });
    const differentWorkspace = buildPreviewRuntimeCacheDir({
      projectRoot: "/repo",
      workspaceRoot: "/repo/apps/marketing",
    });

    expect(first).toBe(second);
    expect(first).not.toBe(differentWorkspace);
    expect(first).toContain("forma-preview-harness-cache");
  });

  it("includes runtime, preview, wrapper, mocks, component, and module mock warmup files", () => {
    const plan = buildPreviewRuntimeWarmupPlan({
      projectRoot: "/repo",
      workspaceRoot: "/repo/apps/web",
      runtimeDir: "/tmp/runtime",
      harnessRuntimeModulePath: "/repo/apps/server/src/preview/harness/runtime.tsx",
      componentRelativePath: "apps/web/src/Button.tsx",
      previewFileRelativePath: "apps/web/src/Button.preview.tsx",
      previewComponentRelativePath: "apps/web/src/Button.preview.mocks.ts",
      moduleMocks: {
        "@/analytics": "apps/web/src/Button.analytics.mock.ts",
      },
    });

    expect(plan.warmupFiles).toEqual(
      expect.arrayContaining([
        path.resolve("/tmp/runtime/src/main.tsx"),
        path.resolve("/repo/apps/server/src/preview/harness/runtime.tsx"),
        path.resolve("/repo/.forma/preview/wrapper.tsx"),
        path.resolve("/repo/.forma/preview/mocks.ts"),
        path.resolve("/repo/apps/web/src/Button.preview.tsx"),
        path.resolve("/repo/apps/web/src/Button.preview.mocks.ts"),
        path.resolve("/repo/apps/web/src/Button.analytics.mock.ts"),
      ]),
    );
    expect(plan.readinessPaths).toEqual(
      expect.arrayContaining([
        "/preview.html",
        "/src/main.tsx",
        "/@fs/repo/apps/web/src/Button.preview.tsx?import",
        "/@fs/repo/.forma/preview/wrapper.tsx?import",
        "/@fs/repo/.forma/preview/mocks.ts?import",
        "/@fs/repo/apps/web/src/Button.preview.mocks.ts?import",
        "/@fs/repo/apps/web/src/Button.analytics.mock.ts?import",
      ]),
    );
  });

  it("parses static component preview paths", () => {
    expect(
      parsePreviewComponentRelativePath(`
        export default defineComponentPreview({
          component: "./ChatComposer.preview.mocks.ts",
        });
      `),
    ).toBe("./ChatComposer.preview.mocks.ts");
  });
});

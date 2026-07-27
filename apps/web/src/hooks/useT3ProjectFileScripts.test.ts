import { describe, expect, it } from "vite-plus/test";

import { resolveT3ProjectFileState } from "./useT3ProjectFileScripts";

function projectFile(contents: string, truncated = false) {
  return {
    relativePath: "t3.json",
    contents,
    byteLength: contents.length,
    truncated,
  };
}

describe("resolveT3ProjectFileState", () => {
  it("decodes repository scripts from a valid t3.json", () => {
    const state = resolveT3ProjectFileState({
      enabled: true,
      data: projectFile(
        JSON.stringify({
          iconPath: "assets/icon.png",
          scripts: [{ name: "Setup", command: "vp i", runOnWorktreeCreate: true }],
        }),
      ),
      error: null,
      isPending: false,
    });

    expect(state.status).toBe("ready");
    expect(state.file?.iconPath).toBe("assets/icon.png");
    expect(state.scripts).toEqual([{ name: "Setup", command: "vp i", runOnWorktreeCreate: true }]);
  });

  it("reports malformed and truncated files as invalid", () => {
    expect(
      resolveT3ProjectFileState({
        enabled: true,
        data: projectFile("{not json"),
        error: null,
        isPending: false,
      }).status,
    ).toBe("invalid");
    expect(
      resolveT3ProjectFileState({
        enabled: true,
        data: projectFile("{}", true),
        error: null,
        isPending: false,
      }).status,
    ).toBe("invalid");
  });

  it("distinguishes unavailable, loading, and disabled states", () => {
    expect(
      resolveT3ProjectFileState({
        enabled: true,
        data: null,
        error: "File not found",
        isPending: false,
      }).status,
    ).toBe("unavailable");
    expect(
      resolveT3ProjectFileState({
        enabled: true,
        data: null,
        error: null,
        isPending: true,
      }).status,
    ).toBe("loading");
    expect(
      resolveT3ProjectFileState({
        enabled: false,
        data: null,
        error: null,
        isPending: false,
      }).status,
    ).toBe("disabled");
  });
});

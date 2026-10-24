import { describe, expect, it } from "vite-plus/test";
import type { ProjectScript } from "@t3tools/contracts";
import { getConfiguredPreviewUrls } from "./previewEmptyStateLogic";

describe("getConfiguredPreviewUrls", () => {
  it("getConfiguredPreviewUrls-reservedPort-expandsOnlyThePreviewPortBeforeDiscovery", () => {
    const scripts = [
      {
        id: "web",
        previewUrl:
          "http://localhost:${T3CODE_PREVIEW_PORT}/app?literal=$OTHER#${T3CODE_PREVIEW_PORT}",
      },
      { id: "fixed", previewUrl: "http://localhost:5173" },
    ] as ProjectScript[];
    expect(getConfiguredPreviewUrls(scripts)).toEqual(["http://localhost:5173"]);
    expect(getConfiguredPreviewUrls(scripts, { web: 25146 })).toEqual([
      "http://localhost:25146/app?literal=$OTHER#25146",
      "http://localhost:5173",
    ]);
  });
});

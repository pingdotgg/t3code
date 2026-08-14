import { describe, expect, it } from "vite-plus/test";

import { buildRepoRootLabels } from "./repoRootLabels";

describe("buildRepoRootLabels", () => {
  it("keeps unique basenames compact", () => {
    expect(
      Object.fromEntries(buildRepoRootLabels(["/workspace/frontend", "/workspace/backend"])),
    ).toEqual({
      "/workspace/frontend": "frontend",
      "/workspace/backend": "backend",
    });
  });

  it("adds parent segments when repository basenames collide", () => {
    expect(Object.fromEntries(buildRepoRootLabels(["/clients/a/app", "/clients/b/app"]))).toEqual({
      "/clients/a/app": "a/app",
      "/clients/b/app": "b/app",
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMetaBarLayout } from "./ComposerMetaBar";

describe("resolveComposerMetaBarLayout", () => {
  it("shows Git controls and execution metadata for a Git project", () => {
    expect(
      resolveComposerMetaBarLayout({
        hasActiveThread: true,
        hasActiveProject: true,
        showGitControls: true,
      }),
    ).toEqual({
      visible: true,
      showGitControls: true,
      showRuntimeAndContext: true,
    });
  });

  it("keeps access and context metadata visible for a non-Git project", () => {
    expect(
      resolveComposerMetaBarLayout({
        hasActiveThread: true,
        hasActiveProject: true,
        showGitControls: false,
      }),
    ).toEqual({
      visible: true,
      showGitControls: false,
      showRuntimeAndContext: true,
    });
  });

  it("does not render without a resolved thread and project", () => {
    expect(
      resolveComposerMetaBarLayout({
        hasActiveThread: false,
        hasActiveProject: true,
        showGitControls: true,
      }),
    ).toEqual({
      visible: false,
      showGitControls: false,
      showRuntimeAndContext: false,
    });
  });
});

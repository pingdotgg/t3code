import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentId, TurnId } from "@t3tools/contracts";

import {
  __readWorkspaceFilePanelStateForTests,
  __resetWorkspaceFilePanelStateForTests,
  closeWorkspaceFilePreview,
  closeWorkspaceSourceControlPanel,
  openWorkspaceFileExplorer,
  openWorkspaceFilePreview,
  openWorkspaceSourceControlPanel,
  reopenWorkspaceFilePanel,
  resolveWorkspaceFilePreviewTarget,
  returnWorkspaceFilePanelBack,
  returnWorkspaceFileExplorerToPreview,
  returnWorkspaceFilePreviewToExplorer,
  setActiveWorkspaceFileExplorerContext,
  type WorkspaceFilePreviewReturnTarget,
  type WorkspaceFilePreviewTarget,
} from "./workspaceFilePreview";

const environmentId = EnvironmentId.make("env-preview-test");
const diffReturnTarget = {
  kind: "diff",
  diffTurnId: TurnId.make("turn-preview-test"),
  diffFilePath: "src/index.ts",
} satisfies WorkspaceFilePreviewReturnTarget;

function createPreviewTarget(relativePath = "src/index.ts"): WorkspaceFilePreviewTarget {
  return {
    environmentId,
    cwd: "/repo/project",
    relativePath,
    displayPath: relativePath,
  };
}

afterEach(() => {
  __resetWorkspaceFilePanelStateForTests();
});

describe("resolveWorkspaceFilePreviewTarget", () => {
  it("resolves absolute workspace paths to relative read targets", () => {
    expect(
      resolveWorkspaceFilePreviewTarget({
        environmentId,
        cwd: "/repo/project",
        targetPath: "/repo/project/src/index.ts:12:4",
      }),
    ).toEqual({
      environmentId,
      cwd: "/repo/project",
      relativePath: "src/index.ts",
      displayPath: "src/index.ts",
      line: 12,
      column: 4,
    });
  });

  it("resolves relative paths and keeps custom display labels", () => {
    expect(
      resolveWorkspaceFilePreviewTarget({
        environmentId,
        cwd: "/repo/project",
        targetPath: "./src/index.ts:3",
        displayPath: "project/src/index.ts:3",
      }),
    ).toEqual({
      environmentId,
      cwd: "/repo/project",
      relativePath: "src/index.ts",
      displayPath: "project/src/index.ts:3",
      line: 3,
    });
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(
      resolveWorkspaceFilePreviewTarget({
        environmentId,
        cwd: "/repo/project",
        targetPath: "/repo/other/src/index.ts",
      }),
    ).toBeNull();
  });
});

describe("workspace file panel state", () => {
  it("opens the explorer and stores its workspace context", () => {
    openWorkspaceFileExplorer({
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      explorerReturnPreview: null,
      returnTarget: null,
    });
  });

  it("opens and closes source control as a file panel view", () => {
    openWorkspaceFilePreview(createPreviewTarget());
    openWorkspaceSourceControlPanel();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "source-control",
      explorerReturnPreview: null,
      returnTarget: null,
      target: {
        environmentId,
        cwd: "/repo/project",
        relativePath: "src/index.ts",
      },
    });

    closeWorkspaceSourceControlPanel();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: false,
      view: "source-control",
    });
  });

  it("keeps stack history across source control, preview, and explorer", () => {
    const previewTarget = createPreviewTarget("src/from-git.ts");
    openWorkspaceSourceControlPanel();
    openWorkspaceFilePreview(previewTarget);
    openWorkspaceFileExplorer({
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      history: [
        { kind: "source-control" },
        {
          kind: "preview",
          target: previewTarget,
        },
      ],
    });

    returnWorkspaceFilePanelBack();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      target: previewTarget,
      history: [{ kind: "source-control" }],
      returnTarget: { kind: "source-control" },
    });

    returnWorkspaceFilePanelBack();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "source-control",
      history: [],
      returnTarget: null,
    });
  });

  it("lets a diff preview opened over source control return to the diff first", () => {
    const previewTarget = createPreviewTarget("src/from-diff.ts");
    openWorkspaceSourceControlPanel();
    openWorkspaceFilePreview(previewTarget, { returnTarget: diffReturnTarget });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      target: previewTarget,
      history: [{ kind: "source-control" }, diffReturnTarget],
      returnTarget: diffReturnTarget,
    });
  });

  it("keeps explorer file previews in the same stack", () => {
    const previewTarget = createPreviewTarget("src/from-git.ts");
    const explorerFileTarget = createPreviewTarget("src/from-explorer.ts");
    const explorerContext = {
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    };

    openWorkspaceSourceControlPanel();
    openWorkspaceFilePreview(previewTarget);
    openWorkspaceFileExplorer(explorerContext);
    openWorkspaceFilePreview(explorerFileTarget);

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      target: explorerFileTarget,
      history: [
        { kind: "source-control" },
        {
          kind: "preview",
          target: previewTarget,
        },
        {
          kind: "explorer",
          context: explorerContext,
        },
      ],
      returnTarget: { kind: "explorer" },
    });

    returnWorkspaceFilePanelBack();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      explorerContext,
      history: [
        { kind: "source-control" },
        {
          kind: "preview",
          target: previewTarget,
        },
      ],
    });

    returnWorkspaceFilePanelBack();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      target: previewTarget,
      history: [{ kind: "source-control" }],
      returnTarget: { kind: "source-control" },
    });

    returnWorkspaceFilePanelBack();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "source-control",
      history: [],
    });
  });

  it("opens a preview from the explorer with an explorer return target", () => {
    openWorkspaceFileExplorer({
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    });
    openWorkspaceFilePreview(createPreviewTarget(), { returnTarget: { kind: "explorer" } });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      explorerReturnPreview: null,
      returnTarget: { kind: "explorer" },
      target: {
        environmentId,
        cwd: "/repo/project",
        relativePath: "src/index.ts",
      },
    });
  });

  it("closes the panel while preserving the last target and clearing return context", () => {
    const previewTarget = createPreviewTarget();
    openWorkspaceFileExplorer(
      {
        environmentId,
        cwd: "/repo/project",
      },
      { returnToPreview: { target: previewTarget, returnTarget: diffReturnTarget } },
    );
    returnWorkspaceFileExplorerToPreview();
    closeWorkspaceFilePreview();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: false,
      view: "preview",
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
      },
      explorerReturnPreview: null,
      history: [],
      returnTarget: null,
      target: {
        environmentId,
        cwd: "/repo/project",
        relativePath: "src/index.ts",
      },
    });
  });

  it("opens explorer as a fresh action without stale preview-return breadcrumbs", () => {
    const previewTarget = createPreviewTarget();
    openWorkspaceFileExplorer(
      {
        environmentId,
        cwd: "/repo/project",
      },
      { returnToPreview: { target: previewTarget, returnTarget: diffReturnTarget } },
    );
    openWorkspaceFileExplorer({
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      explorerReturnPreview: null,
      returnTarget: null,
    });
  });

  it("opens explorer from preview with exactly one preview-return breadcrumb", () => {
    const previewTarget = createPreviewTarget();
    openWorkspaceFileExplorer(
      {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      { returnToPreview: { target: previewTarget, returnTarget: diffReturnTarget } },
    );

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      explorerReturnPreview: {
        target: previewTarget,
        returnTarget: diffReturnTarget,
      },
      returnTarget: null,
    });
  });

  it("returns explorer to preview once and consumes the breadcrumb", () => {
    const previewTarget = createPreviewTarget();
    openWorkspaceFileExplorer(
      {
        environmentId,
        cwd: "/repo/project",
      },
      { returnToPreview: { target: previewTarget, returnTarget: diffReturnTarget } },
    );
    returnWorkspaceFileExplorerToPreview();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      target: previewTarget,
      returnTarget: diffReturnTarget,
      explorerReturnPreview: null,
    });

    returnWorkspaceFileExplorerToPreview();
    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      target: previewTarget,
      returnTarget: diffReturnTarget,
      explorerReturnPreview: null,
    });
  });

  it("returns preview to explorer without creating a reverse breadcrumb", () => {
    openWorkspaceFilePreview(createPreviewTarget(), { returnTarget: { kind: "explorer" } });
    returnWorkspaceFilePreviewToExplorer({
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      explorerReturnPreview: null,
      returnTarget: null,
    });
  });

  it("opens a new explorer file and clears any previous preview breadcrumb", () => {
    const previousTarget = createPreviewTarget("README.md");
    openWorkspaceFileExplorer(
      {
        environmentId,
        cwd: "/repo/project",
      },
      { returnToPreview: { target: previousTarget, returnTarget: diffReturnTarget } },
    );
    openWorkspaceFilePreview(createPreviewTarget("src/next.ts"), {
      returnTarget: { kind: "explorer" },
    });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      explorerReturnPreview: null,
      returnTarget: { kind: "explorer" },
      target: {
        environmentId,
        cwd: "/repo/project",
        relativePath: "src/next.ts",
      },
    });
  });

  it("reopens a stale explorer as the active project explorer", () => {
    openWorkspaceFileExplorer({
      environmentId,
      cwd: "/repo/old",
      projectName: "old",
    });
    closeWorkspaceFilePreview();
    setActiveWorkspaceFileExplorerContext({
      environmentId,
      cwd: "/repo/new",
      projectName: "new",
    });

    reopenWorkspaceFilePanel();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      target: null,
      activeExplorerContext: {
        environmentId,
        cwd: "/repo/new",
        projectName: "new",
      },
      explorerContext: {
        environmentId,
        cwd: "/repo/new",
        projectName: "new",
      },
      explorerReturnPreview: null,
      returnTarget: null,
    });
  });

  it("reopens a stale preview as the active project explorer", () => {
    openWorkspaceFilePreview({
      environmentId,
      cwd: "/repo/old",
      relativePath: "README.md",
      displayPath: "README.md",
    });
    closeWorkspaceFilePreview();
    setActiveWorkspaceFileExplorerContext({
      environmentId,
      cwd: "/repo/new",
      projectName: "new",
    });

    reopenWorkspaceFilePanel();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      target: null,
      activeExplorerContext: {
        environmentId,
        cwd: "/repo/new",
        projectName: "new",
      },
      explorerContext: {
        environmentId,
        cwd: "/repo/new",
        projectName: "new",
      },
      explorerReturnPreview: null,
      returnTarget: null,
    });
  });

  it("preserves matching preview reopen behavior", () => {
    setActiveWorkspaceFileExplorerContext({
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    });
    const target = createPreviewTarget();
    openWorkspaceFilePreview(target);
    closeWorkspaceFilePreview();

    reopenWorkspaceFilePanel();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "preview",
      target,
      activeExplorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
    });
  });

  it("reopens the active explorer when no stored file panel state exists", () => {
    setActiveWorkspaceFileExplorerContext({
      environmentId,
      cwd: "/repo/project",
      projectName: "project",
    });

    reopenWorkspaceFilePanel();

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      open: true,
      view: "explorer",
      target: null,
      activeExplorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "project",
      },
      explorerReturnPreview: null,
      returnTarget: null,
    });
  });

  it("updates projectName for the same explorer workspace", () => {
    openWorkspaceFileExplorer({
      environmentId,
      cwd: "/repo/project",
      projectName: "Old name",
    });

    setActiveWorkspaceFileExplorerContext({
      environmentId,
      cwd: "/repo/project",
      projectName: "New name",
    });

    expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
      activeExplorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "New name",
      },
      explorerContext: {
        environmentId,
        cwd: "/repo/project",
        projectName: "New name",
      },
    });
  });
});

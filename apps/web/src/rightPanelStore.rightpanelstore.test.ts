import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useClosedViewStore } from "./closedViewStore";
import { reopenClosedView } from "./reopenClosedView";
import {
  hostRightPanel,
  migratePersistedRightPanelState,
  pullRequestSurface,
  pullRequestSurfaceId,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelVisibility,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";
beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

async function reloadRightPanelStore() {
  const { storage, name } = useRightPanelStore.persist.getOptions();
  const persisted = await storage!.getItem(name!);
  expect(persisted).not.toBeNull();
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  await storage!.setItem(name!, persisted!);
  await useRightPanelStore.persist.rehydrate();
  expect(useRightPanelStore.persist.hasHydrated()).toBe(true);
}

describe("rightPanelStore", () => {
  const completedDiff = { kind: "diff", turnId: RunId.make("turn-1") } as const;

  const linkedPullRequest = pullRequestSurface({
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 42,
  });

  it("switches to a tab that already shows the folder instead of replacing it", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "apps");
    store.openFile(refA, "apps/web/src", 12);

    store.navigateFolder(refA, "file:apps/web/src", "apps", "apps/web/src");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("file:apps");
    expect(state.surfaces).toEqual([
      { id: "file:apps", kind: "file", relativePath: "apps", revealLine: null, revealRequestId: 1 },
    ]);
  });

  it("keeps a file's tab when walking up from it, and comes back to it", () => {
    const store = useRightPanelStore.getState();
    const state = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    store.openFile(refA, "src/app.ts", 40);

    store.navigateFolder(refA, "file:src/app.ts", "src", "src/app.ts", true);
    expect(state().activeSurfaceId).toBe("file:src");
    expect(state().surfaces).toEqual([
      {
        id: "file:src/app.ts",
        kind: "file",
        relativePath: "src/app.ts",
        revealLine: 40,
        revealRequestId: 1,
      },
      expect.objectContaining({ id: "file:src", folderTrail: "src/app.ts" }),
    ]);

    store.navigateFolder(refA, "file:src", "src/app.ts", "src/app.ts");
    expect(state().activeSurfaceId).toBe("file:src/app.ts");
    expect(state().surfaces).toEqual([
      {
        id: "file:src/app.ts",
        kind: "file",
        relativePath: "src/app.ts",
        revealLine: 40,
        revealRequestId: 1,
      },
    ]);
  });

  it("ignores navigation from a tab that was closed", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "apps");
    const before = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    store.navigateFolder(refA, "file:gone", "", "gone");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toBe(
      before,
    );
  });

  it("replaces the standalone explorer with peer file surfaces", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it.each([
    ["generated\\", "generated"],
    ["notes/meeting ", "notes/meeting"],
    [" notes/meeting", "notes/meeting"],
  ])("keeps %j and %j in separate file tabs", (firstPath, secondPath) => {
    useRightPanelStore.getState().openFile(refA, firstPath);
    useRightPanelStore.getState().openFile(refA, secondPath);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toMatchObject([
      { id: `file:${firstPath}`, relativePath: firstPath },
      { id: `file:${secondPath}`, relativePath: secondPath },
    ]);
  });

  it("keeps attachment and workspace file ids disjoint", () => {
    useRightPanelStore.getState().openFile(refA, "attachment:shared-id");
    useRightPanelStore.getState().openAttachment(refA, {
      type: "file",
      id: "shared-id",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:attachment:shared-id", "attachment:shared-id"]);
  });

  it("updates line reveal requests when reopening a file surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 42);
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 87);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: 87,
          revealRequestId: 2,
        },
      ],
    });

    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 3,
        },
      ],
    });
  });

  it("removes persisted file surfaces when their workspace no longer exists", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().open(refA, "device");
    useRightPanelStore.getState().openFile(refA, "README.md");

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "device",
      surfaces: [{ id: "device", kind: "device" }],
    });

    useRightPanelStore.getState().openFile(refB, "conductor.json");
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("keeps attachment previews when their workspace is unavailable", () => {
    const attachment = {
      type: "file" as const,
      id: "thread-A-attachment-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    };
    useRightPanelStore.getState().openFile(refA, "README.md");
    useRightPanelStore.getState().openAttachment(refA, attachment);

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "attachment:thread-A-attachment-pdf",
      surfaces: [
        {
          id: "attachment:thread-A-attachment-pdf",
          kind: "file",
          relativePath: "report.pdf",
          revealLine: null,
          revealRequestId: 0,
          attachment,
        },
      ],
    });
  });

  it("tracks one surface per pull request", () => {
    const first = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4909 };
    const second = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4910 };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    const url = "https://gitlab.example.com/pingdotgg/t3code/-/merge_requests/4909";
    useRightPanelStore.getState().openPullRequest(refA, { ...first, url });
    useRightPanelStore.getState().openPullRequest(refA, first);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(first),
      pullRequestSurfaceId(second),
    ]);
    expect(state.activeSurfaceId).toBe(pullRequestSurfaceId(first));
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ url });
    expect(state.surfaces[1]).not.toHaveProperty("url");
  });

  it("restores each environment, thread and PR surface's detail tab after reload and URL reopen", async () => {
    const pr = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4909 };
    const otherPr = { ...pr, projectId: "project-b" };
    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    const selections = [
      [refA, pr, "code"],
      [refB, pr, "guide"],
      [otherEnvironment, pr, "timeline"],
      [refA, otherPr, "summary"],
    ] as const;
    const store = useRightPanelStore.getState();
    for (const [ref, reference, tab] of selections) {
      store.openPullRequest(ref, reference);
      store.setPullRequestDetailTab(ref, pullRequestSurfaceId(reference), "guide");
      store.setPullRequestDetailTab(ref, pullRequestSurfaceId(reference), tab);
    }

    store.openPullRequest(refA, pr);
    const revision = store.getUserActionRevision(refA);
    store.setPullRequestDetailTab(refA, pullRequestSurfaceId(pr), "timeline");
    expect(store.openProactive(refA, linkedPullRequest, revision)).toBe(true);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual(
      linkedPullRequest,
    );
    store.setPullRequestDetailTab(refA, pullRequestSurfaceId(pr), "code");

    const { storage, name } = useRightPanelStore.persist.getOptions();
    const saved = await storage!.getItem(name!);
    expect(saved).not.toBeNull();
    useRightPanelStore.setState({ byThreadKey: {} });
    await storage!.setItem(name!, saved!);
    await useRightPanelStore.persist.rehydrate();

    for (const [ref, reference, tab] of selections) {
      store.openPullRequest(ref, {
        ...reference,
        url: `https://github.com/${reference.repository}/pull/${reference.number}`,
      });
      const active = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
      expect(active?.id).toBe(pullRequestSurfaceId(reference));
      expect(active?.kind === "pull-request" && (active.detailTab ?? "summary")).toBe(tab);
      store.closeSurface(ref, active!.id);
      await reopenClosedView(useClosedViewStore.getState().entries[0]!, {
        workspaceAvailable: true,
        openPreview: () => {
          throw new Error("A PR tab must not create a browser session");
        },
      });
      const reopened = selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        ref,
      );
      expect(reopened?.kind === "pull-request" && (reopened.detailTab ?? "summary")).toBe(tab);
    }
  });

  it("keeps matching repository and number on different hosts as separate tabs", () => {
    const first = { projectId: "project-a", repository: "acme/api", number: 7, host: "github.com" };
    const second = { ...first, host: "github.example.com" };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([pullRequestSurface(first), pullRequestSurface(second)]);
    expect(pullRequestSurfaceId({ ...first, host: "GITHUB.COM" })).toBe(
      pullRequestSurfaceId(first),
    );
  });

  it("keeps the page's panel tabs reachable when the set of connected servers changes", () => {
    const panelId = ThreadId.make("pull-requests-panel");
    const stableRef = scopeThreadRef("pull-requests-panel" as EnvironmentId, panelId);
    const fromServerA = {
      environmentId: "server-a",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 1,
    };
    const fromServerB = {
      environmentId: "server-b",
      projectId: "project-b",
      repository: "pingdotgg/t3code",
      number: 2,
    };

    useRightPanelStore.getState().openPullRequest(stableRef, fromServerA);
    useRightPanelStore.getState().openPullRequest(stableRef, fromServerB);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, stableRef);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(fromServerA),
      pullRequestSurfaceId(fromServerB),
    ]);

    const refWhileBothConnected = scopeThreadRef("server-a" as EnvironmentId, panelId);
    const refAfterServerADisconnects = scopeThreadRef("server-b" as EnvironmentId, panelId);
    expect(refWhileBothConnected).not.toEqual(refAfterServerADisconnects);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        refAfterServerADisconnects,
      ).surfaces,
    ).toEqual([]);
  });

  it("tracks split panes and the active pane within a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
    });

    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-2"],
      activeTerminalId: "term-2",
    });
  });

  it("closing the final terminal pane removes its surface and closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-a",
      surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
    });
  });

  it("does not replace a stale surface with a hidden tab, but preserves explicit opens", () => {
    const store = useRightPanelStore.getState();
    store.openBrowser(refA, "stale-tab");
    store.reconcileBrowserSurfaces(refA, ["hidden-tab"], new Set(["hidden-tab"]));
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({
      activeSurfaceId: null,
      surfaces: [],
    });

    store.openBrowser(refA, "hidden-tab");
    store.reconcileBrowserSurfaces(
      refA,
      ["hidden-tab", "other-tab"],
      new Set(["hidden-tab", "other-tab"]),
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "browser:hidden-tab",
      surfaces: [{ id: "browser:hidden-tab", kind: "preview", resourceId: "hidden-tab" }],
    });
  });

  it("hides the panel when browser reconciliation removes its last session tab", () => {
    const store = useRightPanelStore.getState();
    store.openBrowser(refA, "tab-a");
    store.reconcileBrowserSurfaces(refA, []);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });

    store.openBrowser(refA, "tab-b");
    store.open(refA, "diff");
    store.reconcileBrowserSurfaces(refA, []);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ isOpen: true, activeSurfaceId: "diff" });
  });

  it("moves a surface to a new index and keeps it there through browser reconciliation", () => {
    const store = useRightPanelStore.getState();
    store.openTerminal(refA, "term-1");
    store.openBrowser(refA, "tab-a");
    store.open(refA, "diff");
    const revision = store.getUserActionRevision(refA);
    const surfaceIds = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      );

    store.moveSurface(refA, "browser:tab-a", 0);
    expect(surfaceIds()).toEqual(["browser:tab-a", "terminal:term-1", "diff"]);
    store.moveSurface(refA, "browser:tab-a", 2);
    expect(surfaceIds()).toEqual(["terminal:term-1", "diff", "browser:tab-a"]);
    store.moveSurface(refA, "browser:tab-a", 0);

    store.reconcileBrowserSurfaces(refA, ["tab-a", "tab-b"]);
    expect(surfaceIds()).toEqual(["browser:tab-a", "terminal:term-1", "diff", "browser:tab-b"]);
    expect(store.getUserActionRevision(refA)).toBe(revision);
  });
});

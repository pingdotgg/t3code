import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import {
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { retainThreadKeyRecord } from "./ChatView.logic";
import {
  filterVisibleSourceControlSurfaces,
  isSourceControlAvailable,
  resolveSourceControlPanelTarget,
  resolveThreadErrorDismissAction,
  resolveThreadErrorPresentation,
  resolveVisibleSourceControlSurface,
  resolveSourceControlDraftMetadataTarget,
  retargetOpenSourceControlSurface,
  runSourceControlServerMetadataUpdate,
  selectSourceControlMetadataError,
  sourceControlMetadataErrorFromFailure,
} from "./ChatView.sourceControl";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const activeThreadRef = { environmentId, threadId };
const metadata = {
  branch: "feature/source-control",
  worktreePath: "/tmp/source-control",
};
const expectedBranch = "feature/previous-ref";

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("sourceControlMetadataErrorFromFailure", () => {
  it("formats structured object errors without collapsing to object text", () => {
    expect(
      sourceControlMetadataErrorFromFailure({
        code: "ECONNRESET",
        message: "metadata update failed",
      }),
    ).toBe("metadata update failed (ECONNRESET)");
    expect(sourceControlMetadataErrorFromFailure({ detail: "raw provider failure" })).toBe(
      '{"detail":"raw provider failure"}',
    );
  });
});

describe("resolveSourceControlDraftMetadataTarget", () => {
  it("prefers a draft id and falls back to the active thread ref", () => {
    const draftId = DraftId.make("draft-1");

    expect(resolveSourceControlDraftMetadataTarget({ activeThreadRef: null, draftId })).toBe(
      draftId,
    );
    expect(resolveSourceControlDraftMetadataTarget({ activeThreadRef, draftId: null })).toBe(
      activeThreadRef,
    );
    expect(resolveSourceControlDraftMetadataTarget({ activeThreadRef: null, draftId: null })).toBe(
      null,
    );
  });
});

describe("resolveThreadErrorPresentation", () => {
  it("keeps lower-priority Source Control failures available after local errors", () => {
    const input = {
      isServerThread: true,
      localDraftError: null,
      localServerError: "local dispatch failed",
      sessionError: "persisted provider failure",
      sourceControlMetadataError: "metadata update failed",
    } as const;

    expect(resolveThreadErrorPresentation(input)).toEqual({
      error: "local dispatch failed",
      source: "local-server",
    });
    expect(resolveThreadErrorPresentation({ ...input, localServerError: null })).toEqual({
      error: "metadata update failed",
      source: "source-control",
    });
    expect(
      resolveThreadErrorPresentation({
        ...input,
        localServerError: null,
        sourceControlMetadataError: null,
      }),
    ).toEqual({ error: "persisted provider failure", source: "session" });
  });

  it("keeps draft errors independent from server-only error sources", () => {
    expect(
      resolveThreadErrorPresentation({
        isServerThread: false,
        localDraftError: "draft failed",
        localServerError: "ignored server error",
        sessionError: "ignored session error",
        sourceControlMetadataError: "ignored metadata error",
      }),
    ).toEqual({ error: "draft failed", source: "draft" });
  });

  it("dismisses only the error source currently presented", () => {
    expect(resolveThreadErrorDismissAction("draft")).toBe("clear-thread");
    expect(resolveThreadErrorDismissAction("local-server")).toBe("clear-thread");
    expect(resolveThreadErrorDismissAction("source-control")).toBe("clear-source-control");
    expect(resolveThreadErrorDismissAction("session")).toBe("mask-only");
    expect(resolveThreadErrorDismissAction(null)).toBe("mask-only");
  });
});

describe("source control right panel surface visibility", () => {
  const sourceControlSurface = { id: "source-control", kind: "source-control" } as const;
  const pullRequestSurface = {
    id: "pull-request:project-a:pingdotgg%2Ft3code:6392",
    kind: "pull-request",
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 6392,
  } as const;
  const agentsSurface = { id: "agents", kind: "agents" } as const;
  const assertActiveSourceControlSurface = (
    phase: string,
    expectedSurfaces: readonly RightPanelSurface[],
  ) => {
    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    const panelState = selectThreadRightPanelState(byThreadKey, activeThreadRef);
    const activeSurface = selectActiveRightPanelSurface(byThreadKey, activeThreadRef);
    const visibleSurfaces = filterVisibleSourceControlSurfaces({
      sourceControlAvailable: true,
      surfaces: panelState.surfaces,
    });
    const visibleActiveSurface = resolveVisibleSourceControlSurface({
      sourceControlAvailable: true,
      surface: activeSurface,
      visibleSurfaces,
    });

    expect(panelState.isOpen, `${phase}: panel is open`).toBe(true);
    expect(panelState.activeSurfaceId, `${phase}: Source Control is active`).toBe("source-control");
    expect(panelState.surfaces, `${phase}: surface list`).toEqual(expectedSurfaces);
    expect(visibleSurfaces, `${phase}: Source Control is visible`).toContainEqual(
      sourceControlSurface,
    );
    expect(visibleActiveSurface, `${phase}: visible active surface`).toEqual(sourceControlSurface);
  };

  it("requires both a thread ref and Git cwd before making Source Control available", () => {
    expect(isSourceControlAvailable({ activeThreadRef, gitCwd: "/repo", isGitRepo: true })).toBe(
      true,
    );
    expect(
      isSourceControlAvailable({ activeThreadRef: null, gitCwd: "/repo", isGitRepo: true }),
    ).toBe(false);
    expect(isSourceControlAvailable({ activeThreadRef, gitCwd: null, isGitRepo: true })).toBe(
      false,
    );
    expect(isSourceControlAvailable({ activeThreadRef, gitCwd: "/repo", isGitRepo: false })).toBe(
      false,
    );
  });

  it("hides unavailable Source Control surfaces without affecting other surfaces", () => {
    expect(
      filterVisibleSourceControlSurfaces({
        sourceControlAvailable: false,
        surfaces: [sourceControlSurface, agentsSurface],
      }),
    ).toEqual([agentsSurface]);

    const surfaces = [sourceControlSurface, agentsSurface];
    expect(
      filterVisibleSourceControlSurfaces({
        sourceControlAvailable: true,
        surfaces,
      }),
    ).toBe(surfaces);
  });

  it("keeps pull-request tabs visible when Source Control becomes unavailable", () => {
    const visibleSurfaces = filterVisibleSourceControlSurfaces({
      sourceControlAvailable: false,
      surfaces: [sourceControlSurface, pullRequestSurface, agentsSurface],
    });

    expect(visibleSurfaces).toEqual([pullRequestSurface, agentsSurface]);
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: sourceControlSurface,
        visibleSurfaces,
      }),
    ).toBe(pullRequestSurface);
  });

  it("falls back from an unavailable active Source Control surface to another visible surface", () => {
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: sourceControlSurface,
        visibleSurfaces: [agentsSurface],
      }),
    ).toBe(agentsSurface);
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: agentsSurface,
        visibleSurfaces: [agentsSurface],
      }),
    ).toBe(agentsSurface);
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: true,
        surface: sourceControlSurface,
        visibleSurfaces: [sourceControlSurface, agentsSurface],
      }),
    ).toBe(sourceControlSurface);
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: sourceControlSurface,
        visibleSurfaces: [],
      }),
    ).toBe(null);

    const siblingFileSurface = {
      id: "file:/repo/sibling:src/index.ts",
      kind: "file",
      cwd: "/repo/sibling",
      relativePath: "src/index.ts",
      revealLine: 12,
      revealRequestId: 3,
    } as const;
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: sourceControlSurface,
        visibleSurfaces: [siblingFileSurface],
      }),
    ).toBe(siblingFileSurface);
  });

  it("retargets an open singleton surface across grouped project drafts without leaking errors", () => {
    const sharedDraftThreadId = ThreadId.make("grouped-draft");
    const groupedProjectARef = scopeThreadRef(
      EnvironmentId.make("environment-project-a"),
      sharedDraftThreadId,
    );
    const groupedProjectBRef = scopeThreadRef(
      EnvironmentId.make("environment-project-b"),
      sharedDraftThreadId,
    );
    const groupedProjectACwd = "/repos/grouped-project-a";
    const groupedProjectBCwd = "/repos/grouped-project-b";

    useRightPanelStore.getState().open(groupedProjectARef, "source-control");

    const initialByThreadKey = useRightPanelStore.getState().byThreadKey;
    expect(selectActiveRightPanelSurface(initialByThreadKey, groupedProjectBRef)).toBeNull();

    retargetOpenSourceControlSurface({
      currentThreadRef: groupedProjectARef,
      nextThreadRef: groupedProjectBRef,
    });

    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(byThreadKey, groupedProjectARef).surfaces).toEqual([
      sourceControlSurface,
    ]);
    expect(selectThreadRightPanelState(byThreadKey, groupedProjectBRef).surfaces).toEqual([
      sourceControlSurface,
    ]);
    const projectASurface = selectActiveRightPanelSurface(byThreadKey, groupedProjectARef);
    const projectBSurface = selectActiveRightPanelSurface(byThreadKey, groupedProjectBRef);
    expect(
      resolveSourceControlPanelTarget({
        activeThreadRef: groupedProjectARef,
        gitCwd: groupedProjectACwd,
        surface: projectASurface,
      }),
    ).toEqual({
      environmentId: groupedProjectARef.environmentId,
      threadId: groupedProjectARef.threadId,
      cwd: groupedProjectACwd,
    });
    expect(
      resolveSourceControlPanelTarget({
        activeThreadRef: groupedProjectBRef,
        gitCwd: groupedProjectBCwd,
        surface: projectBSurface,
      }),
    ).toEqual({
      environmentId: groupedProjectBRef.environmentId,
      threadId: groupedProjectBRef.threadId,
      cwd: groupedProjectBCwd,
    });

    const projectAThreadKey = scopedThreadKey(groupedProjectARef);
    const projectBThreadKey = scopedThreadKey(groupedProjectBRef);
    const metadataErrors = {
      [projectAThreadKey]: "stale project A metadata failure",
    };

    expect(selectSourceControlMetadataError(metadataErrors, projectAThreadKey)).toBe(
      "stale project A metadata failure",
    );
    expect(selectSourceControlMetadataError(metadataErrors, projectBThreadKey)).toBeNull();
    expect(retainThreadKeyRecord(metadataErrors, new Set([projectBThreadKey]))).toEqual({});
  });

  it("does not update the store when retargeting to the same scoped thread", () => {
    useRightPanelStore.getState().open(activeThreadRef, "source-control");
    const initialByThreadKey = useRightPanelStore.getState().byThreadKey;

    retargetOpenSourceControlSurface({
      currentThreadRef: activeThreadRef,
      nextThreadRef: activeThreadRef,
    });

    expect(useRightPanelStore.getState().byThreadKey).toBe(initialByThreadKey);
  });

  it("keeps Source Control stable while preview stores change independently", () => {
    const previewTabId = "background-preview";
    const previewSurface = {
      id: `browser:${previewTabId}`,
      kind: "preview",
      resourceId: previewTabId,
    } as const;

    useRightPanelStore.getState().open(activeThreadRef, "source-control");
    assertActiveSourceControlSurface("after opening Source Control", [sourceControlSurface]);

    usePreviewMiniPlayerStore.getState().open(activeThreadRef, previewTabId);
    assertActiveSourceControlSurface("after opening the mini-player", [sourceControlSurface]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toMatchObject({ tabId: previewTabId });

    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, [previewTabId]);
    assertActiveSourceControlSurface("after adding the browser surface", [
      sourceControlSurface,
      previewSurface,
    ]);

    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, []);
    assertActiveSourceControlSurface("after removing the browser surface", [sourceControlSurface]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toMatchObject({ tabId: previewTabId });

    usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    assertActiveSourceControlSurface("after closing the mini-player", [sourceControlSurface]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toBeNull();
  });

  it("keeps Source Control stable when the mini-player closes before browser reconciliation", () => {
    const previewTabId = "background-preview";
    const previewSurface = {
      id: `browser:${previewTabId}`,
      kind: "preview",
      resourceId: previewTabId,
    } as const;

    useRightPanelStore.getState().open(activeThreadRef, "source-control");
    usePreviewMiniPlayerStore.getState().open(activeThreadRef, previewTabId);
    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, [previewTabId]);

    usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    assertActiveSourceControlSurface("after closing the mini-player first", [
      sourceControlSurface,
      previewSurface,
    ]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toBeNull();

    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, []);
    assertActiveSourceControlSurface("after reconciling the browser surface", [
      sourceControlSurface,
    ]);
  });
});

describe("runSourceControlServerMetadataUpdate", () => {
  it("sends server-thread metadata and reports success", async () => {
    const calls: unknown[] = [];
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      expectedBranch,
      getCurrentSequence: () => 1,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async (input) => {
        calls.push(input);
        return AsyncResult.success(undefined);
      },
    });

    expect(result).toEqual({ _tag: "Success" });
    expect(calls).toEqual([
      {
        environmentId,
        input: {
          threadId,
          branch: metadata.branch,
          expectedBranch,
          worktreePath: metadata.worktreePath,
        },
      },
    ]);
  });

  it("drops stale results after a newer server-thread metadata request", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      expectedBranch,
      getCurrentSequence: () => 2,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => AsyncResult.failure(Cause.fail("old failure")),
    });

    expect(result).toEqual({ _tag: "Stale" });
  });

  it("drops stale thrown errors after a newer server-thread metadata request", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      expectedBranch,
      getCurrentSequence: () => 2,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => {
        throw { code: "NETWORK", message: "old network failure" };
      },
    });

    expect(result).toEqual({ _tag: "Stale" });
  });

  it("converts thrown update errors into controlled metadata failures", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      expectedBranch,
      getCurrentSequence: () => 1,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => {
        throw { code: "NETWORK", message: "network failed" };
      },
    });

    expect(result).toEqual({
      _tag: "Failure",
      message: "network failed (NETWORK)",
    });
  });

  it("keeps interrupted command results silent", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      expectedBranch,
      getCurrentSequence: () => 1,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => AsyncResult.failure(Cause.interrupt(1)),
    });

    expect(result).toEqual({ _tag: "Interrupted" });
  });

  it("uses the scoped thread key for server update sequencing callers", () => {
    expect(scopedThreadKey(activeThreadRef)).toBe("environment-local:thread-1");
  });
});

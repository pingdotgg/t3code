import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { retainThreadKeyRecord } from "./ChatView.logic";
import {
  filterVisibleSourceControlSurfaces,
  isSourceControlAvailable,
  resolveSourceControlPanelTarget,
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

describe("source control right panel surface visibility", () => {
  const sourceControlSurface = { id: "source-control", kind: "source-control" } as const;
  const planSurface = { id: "plan", kind: "plan" } as const;

  it("requires both a thread ref and Git cwd before making Source Control available", () => {
    expect(isSourceControlAvailable({ activeThreadRef, gitCwd: "/repo" })).toBe(true);
    expect(isSourceControlAvailable({ activeThreadRef: null, gitCwd: "/repo" })).toBe(false);
    expect(isSourceControlAvailable({ activeThreadRef, gitCwd: null })).toBe(false);
  });

  it("hides unavailable Source Control surfaces without affecting other surfaces", () => {
    expect(
      filterVisibleSourceControlSurfaces({
        sourceControlAvailable: false,
        surfaces: [sourceControlSurface, planSurface],
      }),
    ).toEqual([planSurface]);

    const surfaces = [sourceControlSurface, planSurface];
    expect(
      filterVisibleSourceControlSurfaces({
        sourceControlAvailable: true,
        surfaces,
      }),
    ).toBe(surfaces);
  });

  it("falls back from an unavailable active Source Control surface to another visible surface", () => {
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: sourceControlSurface,
        visibleSurfaces: [planSurface],
      }),
    ).toBe(planSurface);
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: planSurface,
        visibleSurfaces: [planSurface],
      }),
    ).toBe(planSurface);
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: true,
        surface: sourceControlSurface,
        visibleSurfaces: [sourceControlSurface, planSurface],
      }),
    ).toBe(sourceControlSurface);
    expect(
      resolveVisibleSourceControlSurface({
        sourceControlAvailable: false,
        surface: sourceControlSurface,
        visibleSurfaces: [],
      }),
    ).toBe(null);
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

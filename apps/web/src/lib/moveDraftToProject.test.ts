import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, type T3ProjectFile } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  readPendingWorkspaceDefault,
  resolveDraftWorkspace,
  waitForPendingWorkspaceDefault,
} from "./retargetDraftWorkspace";
import { moveDraftToProject } from "./moveDraftToProject";

const environmentId = EnvironmentId.make("environment-local");
const draftId = DraftId.make("draft-1");

const files = vi.hoisted(() => new Map<string, Promise<T3ProjectFile | null>>());

vi.mock("./t3ProjectFileDefaults", () => ({
  peekT3ProjectFile: () => undefined,
  readT3ProjectFile: (_environmentId: EnvironmentId, root: string) =>
    files.get(root) ?? Promise.resolve(null),
}));

vi.mock("../state/presentation", async (original) => {
  const actual = await original<typeof import("../state/presentation")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      connectedEnvironmentIdsAtom: Atom.make(() => [environmentId]),
    },
  };
});

function makeProject(name: string): EnvironmentProject {
  return {
    id: ProjectId.make(name),
    environmentId,
    title: name,
    workspaceRoot: `/work/${name}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    scripts: [],
  };
}

const current = makeProject("current");
const added = makeProject("added");
const currentRef = scopeProjectRef(environmentId, current.id);
const addedRef = scopeProjectRef(environmentId, added.id);

beforeEach(() => {
  files.clear();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useComposerDraftStore.getState().setProjectDraftThreadId(currentRef, draftId);
});

describe("moveDraftToProject", () => {
  it("moves a draft the user wrote in, leaving no draft behind in its old project", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Plan the next project");

    expect(moveDraftToProject(draftId, added)).toBe(true);

    expect(store.getDraftSessionByProjectRef(addedRef)?.draftId).toBe(draftId);
    expect(store.getDraftSessionByProjectRef(currentRef)).toBeNull();
    expect(store.getComposerDraft(draftId)?.prompt).toBe("Plan the next project");
  });

  it("leaves an empty draft in its project", () => {
    expect(moveDraftToProject(draftId, added)).toBe(false);

    const store = useComposerDraftStore.getState();
    expect(store.getDraftSessionByProjectRef(currentRef)?.draftId).toBe(draftId);
    expect(store.getDraftSessionByProjectRef(addedRef)).toBeNull();
  });

  it.each(["another project", "back to the source", "a workspace choice"] as const)(
    "ignores the original file result after %s",
    async (change) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(draftId, "Keep this text");
      const sourceRead = Promise.withResolvers<T3ProjectFile | null>();
      const returnRead = Promise.withResolvers<T3ProjectFile | null>();
      files.set(current.workspaceRoot, sourceRead.promise);
      resolveDraftWorkspace(currentRef, current, undefined).applyProjectFile(draftId);
      const sourcePending = readPendingWorkspaceDefault(draftId);
      expect(sourcePending).not.toBeNull();
      const sendWaiting = waitForPendingWorkspaceDefault(draftId);

      if (change === "a workspace choice") {
        store.setDraftThreadContext(draftId, { envMode: "local", workspaceExplicit: true });
      } else {
        moveDraftToProject(draftId, added);
        if (change === "back to the source") {
          files.set(current.workspaceRoot, returnRead.promise);
          moveDraftToProject(draftId, current);
        }
      }
      const currentPending = readPendingWorkspaceDefault(draftId);
      expect(currentPending).not.toBe(sourcePending);
      await expect(
        Promise.race([sourcePending, Promise.resolve("waiting")]),
      ).resolves.toBeUndefined();

      sourceRead.resolve({ defaultThreadEnvMode: "worktree" });
      await sourceRead.promise;
      expect(store.getDraftSession(draftId)?.envMode).toBe("local");
      if (change === "back to the source") {
        expect(readPendingWorkspaceDefault(draftId)).toBe(currentPending);
        await expect(Promise.race([sendWaiting, Promise.resolve("waiting")])).resolves.toBe(
          "waiting",
        );
        returnRead.resolve({ defaultThreadEnvMode: "worktree" });
      }
      await sendWaiting;
      expect(store.getDraftSession(draftId)?.envMode).toBe(
        change === "back to the source" ? "worktree" : "local",
      );
    },
  );
});

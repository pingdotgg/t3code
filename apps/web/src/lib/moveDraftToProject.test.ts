import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { readPendingWorkspaceDefault, withDraftBranchChoice } from "./draftWorkspaceDefaults";
import { moveDraftToProject } from "./moveDraftToProject";
import { retargetDraftWorkspace } from "./retargetDraftWorkspace";

vi.mock("./retargetDraftWorkspace", () => ({ retargetDraftWorkspace: vi.fn(async () => ({})) }));

type DestinationWorkspace = Awaited<ReturnType<typeof retargetDraftWorkspace>>;

function readDestinationLater() {
  const read = Promise.withResolvers<DestinationWorkspace>();
  vi.mocked(retargetDraftWorkspace).mockReturnValueOnce(read.promise);
  return read;
}

const worktreeDefault = { envMode: "worktree", startFromOrigin: true } as const;

const environmentId = EnvironmentId.make("environment-local");
const draftId = DraftId.make("draft-1");

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

  it("applies the destination's workspace default to a moved draft", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Plan the next project");
    const read = readDestinationLater();

    moveDraftToProject(draftId, added);
    const pending = readPendingWorkspaceDefault(draftId);
    expect(pending).not.toBeNull();

    read.resolve(worktreeDefault);
    expect(await pending).toBe(true);
    expect(store.getDraftSession(draftId)?.envMode).toBe("worktree");
  });

  it("keeps the current checkout when the user picks it while the destination file loads", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Plan the next project");
    const read = readDestinationLater();

    moveDraftToProject(draftId, added);
    const pending = readPendingWorkspaceDefault(draftId);
    store.setDraftThreadContext(draftId, { envMode: "local", workspaceExplicit: true });

    read.resolve(worktreeDefault);
    await pending;
    expect(store.getDraftSession(draftId)?.envMode).toBe("local");
  });

  it("stops a waiting send when the draft moves again, even after a branch pick", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Plan the next project");
    const first = readDestinationLater();

    moveDraftToProject(draftId, added);
    const pending = readPendingWorkspaceDefault(draftId);
    await withDraftBranchChoice(draftId, async (commit) => {
      store.setDraftThreadContext(draftId, { branch: "feature" });
      commit();
    });
    moveDraftToProject(draftId, current);

    expect(await pending).toBe(false);
    first.resolve(worktreeDefault);
    await first.promise;
    expect(store.getDraftSession(draftId)?.envMode).toBe("local");
  });

  it.each([
    { committed: false, mode: "worktree", branch: null },
    { committed: true, mode: "local", branch: "feature" },
  ])(
    "applies workspace mode $mode after a branch action with committed=$committed",
    async ({ committed, mode, branch }) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(draftId, "Plan the next project");
      const read = readDestinationLater();
      const branchAction = Promise.withResolvers<void>();

      moveDraftToProject(draftId, added);
      const pending = readPendingWorkspaceDefault(draftId);
      expect(pending).not.toBeNull();
      const choice = withDraftBranchChoice(draftId, async (commit) => {
        await branchAction.promise;
        if (committed) {
          store.setDraftThreadContext(draftId, { branch: "feature" });
          commit();
        }
      });

      read.resolve(worktreeDefault);
      await read.promise;
      expect(store.getDraftSession(draftId)?.envMode).toBe("local");
      branchAction.resolve();
      await choice;
      await pending;
      expect(store.getDraftSession(draftId)).toMatchObject({ envMode: mode, branch });
    },
  );
});

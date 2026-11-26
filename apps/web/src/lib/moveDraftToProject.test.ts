import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, type T3ProjectFile } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { moveDraftToProject } from "./moveDraftToProject";
import { readPendingWorkspaceDefault } from "./retargetDraftWorkspace";
import { readT3ProjectFile } from "./t3ProjectFileDefaults";

vi.mock("./t3ProjectFileDefaults", () => ({
  peekT3ProjectFile: () => undefined,
  readT3ProjectFile: vi.fn(async () => null),
}));

vi.mock("../state/presentation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/presentation")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      connectedEnvironmentIdsAtom: Atom.make([EnvironmentId.make("environment-local")]),
    },
  };
});

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

  it("keeps the current checkout when the user picks it while the destination file loads", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Plan the next project");
    const read = Promise.withResolvers<T3ProjectFile | null>();
    vi.mocked(readT3ProjectFile).mockReturnValueOnce(read.promise);

    moveDraftToProject(draftId, added);
    const pending = readPendingWorkspaceDefault(draftId);
    expect(pending).not.toBeNull();
    store.setDraftThreadContext(draftId, { envMode: "local", workspaceExplicit: true });

    read.resolve({ defaultThreadEnvMode: "worktree" });
    await pending;
    expect(store.getDraftSession(draftId)?.envMode).toBe("local");
  });

  it("ignores a previous visit's file result when the draft returns to the same project", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Plan the next project");
    const first = Promise.withResolvers<T3ProjectFile | null>();
    const latest = Promise.withResolvers<T3ProjectFile | null>();
    vi.mocked(readT3ProjectFile)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);

    moveDraftToProject(draftId, added);
    const firstPending = readPendingWorkspaceDefault(draftId);
    moveDraftToProject(draftId, { ...current, defaultThreadEnvMode: "local" });
    moveDraftToProject(draftId, added);
    const latestPending = readPendingWorkspaceDefault(draftId);
    expect(firstPending).not.toBeNull();
    expect(latestPending).not.toBeNull();

    latest.resolve(null);
    await latestPending;
    first.resolve({ defaultThreadEnvMode: "worktree" });
    await firstPending;

    expect(store.getDraftSession(draftId)?.envMode).toBe("local");
  });
});

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { moveDraftToProject } from "./moveDraftToProject";

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
});

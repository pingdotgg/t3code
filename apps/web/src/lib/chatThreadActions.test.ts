import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveScopedNewThreadProjectRef,
  resolveNewThreadModelSelectionOverride,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-2");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");
const REMOTE_PROJECT_ID = ProjectId.make("project-3");
const SCOPE = {
  representative: { environmentId: ENVIRONMENT_ID, id: PROJECT_ID },
  memberProjectRefs: [
    scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    scopeProjectRef(REMOTE_ENVIRONMENT_ID, REMOTE_PROJECT_ID),
  ],
};
const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("keeps a viewed thread inside the scope on its own machine", () => {
    const projectRef = resolveScopedNewThreadProjectRef(
      {
        activeThread: { environmentId: REMOTE_ENVIRONMENT_ID, projectId: REMOTE_PROJECT_ID },
        activeDraftThread: null,
      },
      SCOPE,
    );

    expect(projectRef).toEqual(scopeProjectRef(REMOTE_ENVIRONMENT_ID, REMOTE_PROJECT_ID));
  });

  it("uses the scoped project when the viewed thread is outside the scope", () => {
    const projectRef = resolveScopedNewThreadProjectRef(
      {
        activeThread: { environmentId: ENVIRONMENT_ID, projectId: FALLBACK_PROJECT_ID },
        activeDraftThread: null,
      },
      SCOPE,
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});

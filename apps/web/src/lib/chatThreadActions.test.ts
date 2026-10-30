import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  restrictNewThreadContext,
  resolveNewThreadModelSelectionOverride,
  startNewThreadFromContext,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("creates within the selected tab even when the open thread and default project are excluded", async () => {
    const environmentId = EnvironmentId.make("env");
    const excluded = { environmentId, projectId: ProjectId.make("excluded") };
    const included = { environmentId, projectId: ProjectId.make("included") };
    const created: (typeof included)[] = [];
    const context = {
      activeThread: excluded,
      activeDraftThread: excluded,
      defaultProjectRef: excluded,
      handleNewThread: async (ref: typeof included) => {
        created.push(ref);
      },
    };
    expect(
      await startNewThreadFromContext(
        restrictNewThreadContext(context, new Set(["env:included"]), included),
      ),
    ).toBe(true);
    expect(created).toEqual([included]);
    expect(
      await startNewThreadFromContext(restrictNewThreadContext(context, new Set(), null)),
    ).toBe(false);
    expect(created).toHaveLength(1);
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

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveNewThreadDefaults, retargetDraftToProject } from "./chatThreadActions";

const projectId = ProjectId.make("project-a");
const ENVIRONMENT_DEFAULT: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const PROJECT_DEFAULT: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-mini",
  options: [{ id: "reasoningEffort", value: "low" }],
};
const lastUsed = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "auto",
  interactionMode: "plan",
} as const;

function settingsFor(overrides: Partial<ServerSettings> = {}) {
  return resolveProjectSettings(
    {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: ENVIRONMENT_DEFAULT,
      defaultRuntimeMode: "approval-required",
      ...overrides,
    },
    projectId,
  );
}

describe("resolveNewThreadDefaults", () => {
  it("prefers the project's last-used settings over environment defaults", () => {
    expect(resolveNewThreadDefaults({ projectSettings: settingsFor(), lastUsed })).toEqual({
      modelSelection: lastUsed.modelSelection,
      runtimeMode: "auto",
      interactionMode: "plan",
    });
  });

  it("falls back to environment defaults for a project nobody has used", () => {
    expect(resolveNewThreadDefaults({ projectSettings: settingsFor(), lastUsed: null })).toEqual({
      modelSelection: ENVIRONMENT_DEFAULT,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });

  it("lets settings configured on the project itself win over its last-used settings", () => {
    const projectSettings = settingsFor({
      projectSettingsOverrides: {
        [projectId]: { defaultModelSelection: PROJECT_DEFAULT, defaultRuntimeMode: "full-access" },
      },
    });

    expect(resolveNewThreadDefaults({ projectSettings, lastUsed })).toEqual({
      modelSelection: PROJECT_DEFAULT,
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
  });
});

describe("retargetDraftToProject", () => {
  const sourceRef = { environmentId: EnvironmentId.make("environment-a"), projectId };
  const destinationRef = {
    environmentId: EnvironmentId.make("environment-b"),
    projectId: ProjectId.make("project-b"),
  };
  const draftId = DraftId.make("draft-retarget");
  const store = () => useComposerDraftStore.getState();
  const session = () => store().getDraftSession(draftId);
  const composer = () => store().getComposerDraft(draftId);
  const selection = (instance: string) =>
    composer()?.modelSelectionByProvider[ProviderInstanceId.make(instance)];
  const manualRouting = {
    environmentSelection: "manual",
    loadBalancedEnvironmentId: null,
  } as const;
  const autoRouting = {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: destinationRef.environmentId,
  } as const;

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    // The draft opened in A inherited A's last-used settings into its session.
    store().setProjectDraftThreadId(sourceRef, draftId, {
      threadId: ThreadId.make("thread-retarget"),
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
    store().setModelSelection(draftId, lastUsed.modelSelection, { replaceOptions: true });
    store().setPrompt(draftId, "keep this");
  });

  const retarget = (overrides: Partial<Parameters<typeof retargetDraftToProject>[0]> = {}) =>
    retargetDraftToProject({
      draftId,
      projectRef: destinationRef,
      project: null,
      environmentSettings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: ENVIRONMENT_DEFAULT,
        defaultRuntimeMode: "approval-required",
      },
      threads: [],
      logicalProjectKey: null,
      refreshModel: true,
      ...overrides,
    });

  it.each([
    ["a machine switch", { routing: manualRouting }],
    ["automatic routing", { routing: autoRouting, refreshModel: false }],
    ["a project pick", { logicalProjectKey: "project-b" }],
  ])("drops the source's inherited modes on %s to an unused project", (_, overrides) => {
    retarget(overrides);

    expect(session()).toMatchObject({
      environmentId: destinationRef.environmentId,
      projectId: destinationRef.projectId,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(composer()?.prompt).toBe("keep this");
  });

  it("takes the destination project's own history over its environment default", () => {
    retarget({
      environmentSettings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "full-access" },
      threads: [
        {
          ...destinationRef,
          modelSelection: PROJECT_DEFAULT,
          runtimeMode: "approval-required",
          interactionMode: "default",
          updatedAt: "2026-10-21T10:00:00.000Z",
          latestUserAuthoredMessageAt: "2026-10-21T10:00:00.000Z",
        },
      ],
    });

    expect(session()).toMatchObject({ runtimeMode: "approval-required" });
    expect(selection("codex")).toEqual(PROJECT_DEFAULT);
  });

  it("leaves modes and a model the user picked in the composer alone", () => {
    store().setRuntimeMode(draftId, "full-access");
    store().setInteractionMode(draftId, "plan");
    store().setModelSelection(draftId, PROJECT_DEFAULT, { explicit: true });
    retarget();

    expect(composer()).toMatchObject({ runtimeMode: "full-access", interactionMode: "plan" });
    expect(selection("codex")).toEqual(PROJECT_DEFAULT);
  });

  it("refreshes an inherited model on a manual switch but keeps it under automatic routing", () => {
    retarget({ routing: autoRouting, refreshModel: false });
    expect(selection("codex")).toEqual(lastUsed.modelSelection);

    retarget({ routing: manualRouting });
    expect(composer()?.activeProvider).toBe("claudeAgent");
    expect(selection("claudeAgent")).toEqual(ENVIRONMENT_DEFAULT);
  });
});

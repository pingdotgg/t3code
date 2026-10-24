import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveProjectLastUsedSettings,
  type ProjectLastUsedSettingsThread,
} from "./projectLastUsedSettings.ts";

const environmentId = EnvironmentId.make("environment-a");
const projectId = ProjectId.make("project-a");

function thread(
  model: string,
  overrides: Partial<ProjectLastUsedSettingsThread> = {},
): ProjectLastUsedSettingsThread {
  return {
    environmentId,
    projectId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
    runtimeMode: "full-access",
    interactionMode: "default",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveProjectLastUsedSettings", () => {
  it("uses the project thread the user last wrote in", () => {
    const settings = resolveProjectLastUsedSettings(
      [
        thread("renamed-recently", {
          updatedAt: "2026-10-05T00:00:00.000Z",
          latestUserAuthoredMessageAt: "2026-10-02T00:00:00.000Z",
        }),
        thread("written-recently", {
          runtimeMode: "auto",
          interactionMode: "plan",
          latestUserAuthoredMessageAt: "2026-10-03T00:00:00.000Z",
        }),
      ],
      { environmentId, projectId },
    );

    expect(settings).toEqual({
      modelSelection: { instanceId: "codex", model: "written-recently" },
      runtimeMode: "auto",
      interactionMode: "plan",
    });
  });

  it("skips threads the user never wrote in, however recent", () => {
    const settings = resolveProjectLastUsedSettings(
      [
        thread("user-written", {
          runtimeMode: "auto",
          latestUserAuthoredMessageAt: "2026-10-02T00:00:00.000Z",
        }),
        thread("scheduled-run", {
          updatedAt: "2026-10-09T00:00:00.000Z",
          latestUserAuthoredMessageAt: null,
        }),
        thread("legacy-recent", { updatedAt: "2026-10-08T00:00:00.000Z" }),
      ],
      { environmentId, projectId },
    );

    expect(settings?.modelSelection.model).toBe("user-written");
    expect(
      resolveProjectLastUsedSettings([thread("automated", { latestUserAuthoredMessageAt: null })], {
        environmentId,
        projectId,
      }),
    ).toBeNull();
  });

  it("falls back to the latest update on servers without authored timestamps", () => {
    const settings = resolveProjectLastUsedSettings(
      [thread("older"), thread("newer", { updatedAt: "2026-10-03T00:00:00.000Z" })],
      { environmentId, projectId },
    );

    expect(settings?.modelSelection.model).toBe("newer");
  });

  it("ignores other projects, other environments, and subagent threads", () => {
    const later = { updatedAt: "2026-10-09T00:00:00.000Z" };
    const settings = resolveProjectLastUsedSettings(
      [
        thread("own"),
        thread("other-project", { ...later, projectId: ProjectId.make("project-b") }),
        thread("other-environment", { ...later, environmentId: EnvironmentId.make("env-b") }),
        thread("subagent", { ...later, lineage: { relationshipToParent: "subagent" } }),
      ],
      { environmentId, projectId },
    );

    expect(settings?.modelSelection.model).toBe("own");
    expect(resolveProjectLastUsedSettings([], { environmentId, projectId })).toBeNull();
  });
});

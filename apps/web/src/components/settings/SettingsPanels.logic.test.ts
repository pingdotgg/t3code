import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { Project, ThreadShell } from "../../types";
import {
  buildArchivedThreadGroups,
  buildProviderInstanceUpdatePatch,
} from "./SettingsPanels.logic";

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("buildArchivedThreadGroups", () => {
  const makeProject = (environmentId: string, id: string, name: string): Project => ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    name,
    cwd: `/tmp/${environmentId}/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  });

  const makeThread = (
    environmentId: string,
    projectId: string,
    id: string,
    archivedAt: string | null,
  ): ThreadShell => ({
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    codexThreadId: null,
    projectId: ProjectId.make(projectId),
    parentThreadId: null,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
      options: [],
    },
    runtimeMode: "full-access",
    pendingRuntimeMode: null,
    interactionMode: "default",
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
    branch: null,
    worktreePath: null,
  });

  it("scopes archived threads by environment and project", () => {
    const envAProject = makeProject("env-a", "project-1", "Env A Project");
    const envBProject = makeProject("env-b", "project-1", "Env B Project");
    const envAArchived = makeThread(
      "env-a",
      "project-1",
      "thread-archived-a",
      "2026-01-03T00:00:00.000Z",
    );
    const envBArchived = makeThread(
      "env-b",
      "project-1",
      "thread-archived-b",
      "2026-01-02T00:00:00.000Z",
    );

    const groups = buildArchivedThreadGroups({
      projects: [envAProject, envBProject],
      threads: [
        envAArchived,
        envBArchived,
        makeThread("env-a", "project-1", "thread-active-a", null),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]?.project.environmentId).toBe(envAProject.environmentId);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual([envAArchived.id]);
    expect(groups[1]?.project.environmentId).toBe(envBProject.environmentId);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual([envBArchived.id]);
  });
});

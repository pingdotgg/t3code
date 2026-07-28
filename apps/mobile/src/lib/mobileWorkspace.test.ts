import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderDriverMap,
  isMobileWorkspaceThread,
  mobileProviderInstanceKey,
  resolveHermesConversationTarget,
} from "./mobileWorkspace";

const environmentId = EnvironmentId.make("environment:local");
const hermesInstanceId = ProviderInstanceId.make("hermes-primary");
const rootThreadId = ThreadId.make("thread:root");

function project(
  id: string,
  workspaceRoot: string,
  projectEnvironmentId = environmentId,
): EnvironmentProject {
  return {
    environmentId: projectEnvironmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    t3WorkDirectory: "/private/t3-work",
    providers: [
      {
        instanceId: hermesInstanceId,
        driver: ProviderDriverKind.make("hermes"),
        enabled: true,
        installed: true,
        status: "ready",
        models: [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            capabilities: null,
          },
        ],
      },
    ],
    ...overrides,
  } as unknown as ServerConfig;
}

describe("mobile workspace routing", () => {
  it("recognizes custom Hermes instance ids from provider metadata", () => {
    const configs = new Map([[environmentId, serverConfig()]]);
    const drivers = buildProviderDriverMap(configs);
    const thread: Parameters<typeof isMobileWorkspaceThread>[0] = {
      environmentId,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId,
      },
      providerInstanceId: hermesInstanceId,
      modelSelection: { instanceId: hermesInstanceId, model: "default" },
      runtime: null,
    };

    expect(drivers.get(mobileProviderInstanceKey(environmentId, hermesInstanceId))).toBe("hermes");
    expect(isMobileWorkspaceThread(thread, "work", drivers)).toBe(true);
    expect(isMobileWorkspaceThread(thread, "code", drivers)).toBe(false);
  });

  it("splits Hermes and non-Hermes threads between Work and Code", () => {
    const codexInstanceId = ProviderInstanceId.make("codex");
    const config = serverConfig();
    const configs = new Map([
      [
        environmentId,
        {
          ...config,
          providers: [
            ...config.providers,
            { ...config.providers[0], instanceId: codexInstanceId, driver: "codex" },
          ],
        } as ServerConfig,
      ],
    ]);
    const drivers = buildProviderDriverMap(configs);
    const codeThread: Parameters<typeof isMobileWorkspaceThread>[0] = {
      environmentId,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId,
      },
      providerInstanceId: codexInstanceId,
      modelSelection: { instanceId: codexInstanceId, model: "default" },
      runtime: null,
    };

    expect(isMobileWorkspaceThread(codeThread, "code", drivers)).toBe(true);
    expect(isMobileWorkspaceThread(codeThread, "work", drivers)).toBe(false);
  });

  it("excludes archived and subagent threads from both workspaces", () => {
    const drivers = buildProviderDriverMap(new Map([[environmentId, serverConfig()]]));
    const base: Parameters<typeof isMobileWorkspaceThread>[0] = {
      environmentId,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId,
      },
      providerInstanceId: hermesInstanceId,
      modelSelection: { instanceId: hermesInstanceId, model: "default" },
      runtime: null,
    };

    expect(
      isMobileWorkspaceThread({ ...base, archivedAt: "2026-07-26T00:00:00.000Z" }, "code", drivers),
    ).toBe(false);
    expect(
      isMobileWorkspaceThread(
        {
          ...base,
          lineage: {
            ...base.lineage,
            parentThreadId: rootThreadId,
            relationshipToParent: "subagent",
          },
        },
        "work",
        drivers,
      ),
    ).toBe(false);
  });

  it("routes new Work conversations through the private backing project", () => {
    const ordinaryProject = project("project:ordinary", "/workspace/repo");
    const backingProject = project("project:t3-work", "/private/t3-work");

    expect(
      resolveHermesConversationTarget({
        projects: [ordinaryProject, backingProject],
        serverConfigs: new Map([[environmentId, serverConfig()]]),
        requiredEnvironmentId: null,
      }),
    ).toEqual({
      project: backingProject,
      modelSelection: {
        instanceId: hermesInstanceId,
        model: "default",
      },
    });
  });

  it("routes new Work conversations through the selected environment", () => {
    const otherEnvironmentId = EnvironmentId.make("environment:other");
    const firstBackingProject = project(
      "project:first-t3-work",
      "/private/t3-work",
      otherEnvironmentId,
    );
    const selectedBackingProject = project("project:selected-t3-work", "/private/t3-work");

    expect(
      resolveHermesConversationTarget({
        projects: [firstBackingProject, selectedBackingProject],
        serverConfigs: new Map([
          [otherEnvironmentId, serverConfig()],
          [environmentId, serverConfig()],
        ]),
        requiredEnvironmentId: environmentId,
      }),
    ).toEqual({
      project: selectedBackingProject,
      modelSelection: {
        instanceId: hermesInstanceId,
        model: "default",
      },
    });
  });

  it("falls back to a later ready Hermes provider when the first has no models", () => {
    const backingProject = project("project:t3-work", "/private/t3-work");
    const modellessInstanceId = ProviderInstanceId.make("hermes-modelless");
    const config = serverConfig();
    const configs = new Map([
      [
        environmentId,
        {
          ...config,
          providers: [
            { ...config.providers[0], instanceId: modellessInstanceId, models: [] },
            ...config.providers,
          ],
        } as ServerConfig,
      ],
    ]);

    expect(
      resolveHermesConversationTarget({
        projects: [backingProject],
        serverConfigs: configs,
        requiredEnvironmentId: null,
      }),
    ).toEqual({
      project: backingProject,
      modelSelection: {
        instanceId: hermesInstanceId,
        model: "default",
      },
    });
  });

  it("does not attach Work conversations to an arbitrary project while setup is incomplete", () => {
    expect(
      resolveHermesConversationTarget({
        projects: [project("project:ordinary", "/workspace/repo")],
        serverConfigs: new Map([[environmentId, serverConfig()]]),
        requiredEnvironmentId: null,
      }),
    ).toBeNull();
    expect(
      resolveHermesConversationTarget({
        projects: [project("project:t3-work", "/private/t3-work")],
        serverConfigs: new Map([[environmentId, serverConfig({ t3WorkDirectory: undefined })]]),
        requiredEnvironmentId: null,
      }),
    ).toBeNull();
  });
});

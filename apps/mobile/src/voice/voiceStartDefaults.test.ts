import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
  type ThreadEnvMode,
  type VcsRef,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createVoiceMobileStartDefaultsResolver,
  VoiceMobileStartDefaultsUnavailableError,
  type VoiceMobileStartDefaultsResolverDependencies,
} from "./voiceStartDefaults";

const ENVIRONMENT_ID = EnvironmentId.make("environment-mobile");
const PROJECT_ID = ProjectId.make("project-mobile");
const NOW = "2026-08-11T10:00:00.000Z";
const CODEX = ProviderInstanceId.make("codex-mobile");

function model(modelName: string, options?: ModelSelection["options"]): ModelSelection {
  return {
    instanceId: CODEX,
    model: modelName,
    ...(options === undefined ? {} : { options }),
  };
}

function project(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: ENVIRONMENT_ID,
    id: PROJECT_ID,
    title: "Mobile project",
    workspaceRoot: "/workspace/mobile",
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function provider(input: {
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean;
    readonly isLegacy?: boolean;
  }>;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly authStatus?: "authenticated" | "unauthenticated";
}): ServerConfig["providers"][number] {
  const enabled = input.enabled ?? true;
  const installed = input.installed ?? true;
  return {
    instanceId: CODEX,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex Mobile",
    enabled,
    installed,
    version: null,
    status: enabled ? (installed ? "ready" : "error") : "disabled",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: NOW,
    models: input.models.map((entry) => ({
      slug: entry.slug,
      name: entry.slug,
      isCustom: false,
      ...(entry.isDefault === undefined ? {} : { isDefault: entry.isDefault }),
      ...(entry.isLegacy === undefined ? {} : { isLegacy: entry.isLegacy }),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  } satisfies ServerConfig["providers"][number];
}

function config(
  input: {
    readonly envMode?: ThreadEnvMode;
    readonly startFromOrigin?: boolean;
    readonly providers?: ReadonlyArray<ReturnType<typeof provider>>;
  } = {},
): ServerConfig {
  return {
    environment: {
      environmentId: ENVIRONMENT_ID,
      label: "Mobile environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        connectionProbe: true,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-access-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/workspace/mobile",
    keybindingsConfigPath: "/workspace/mobile/keybindings.json",
    keybindings: [],
    issues: [],
    providers: input.providers ?? [
      provider({
        models: [
          { slug: "first-model" },
          { slug: "config-default", isDefault: true },
          { slug: "project-model" },
        ],
      }),
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/tmp/t3-mobile-test-logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultThreadEnvMode: input.envMode ?? "local",
      newWorktreesStartFromOrigin: input.startFromOrigin ?? true,
    },
  } satisfies ServerConfig;
}

function ref(name: string, overrides: Partial<VcsRef> = {}): VcsRef {
  return {
    name,
    current: false,
    isDefault: false,
    worktreePath: null,
    ...overrides,
  };
}

function harness(input: {
  readonly serverConfig?: ServerConfig | null;
  readonly projectFile?: string | null;
  readonly projectFileTruncated?: boolean;
  readonly refs?: ReadonlyArray<VcsRef>;
  readonly isRepo?: boolean;
}) {
  const readTargetServerConfig = vi.fn<
    VoiceMobileStartDefaultsResolverDependencies["readTargetServerConfig"]
  >(() => (input.serverConfig === undefined ? config() : input.serverConfig));
  const readProjectFile = vi.fn<VoiceMobileStartDefaultsResolverDependencies["readProjectFile"]>(
    () =>
      input.projectFile === null
        ? null
        : {
            relativePath: "t3.json",
            contents: input.projectFile ?? "{}",
            byteLength: (input.projectFile ?? "{}").length,
            truncated: input.projectFileTruncated ?? false,
          },
  );
  const listRefs = vi.fn<VoiceMobileStartDefaultsResolverDependencies["listRefs"]>(() => ({
    isRepo: input.isRepo ?? true,
    refs: input.refs ?? [ref("main", { current: true })],
  }));
  return {
    readTargetServerConfig,
    readProjectFile,
    listRefs,
    resolver: createVoiceMobileStartDefaultsResolver({
      readTargetServerConfig,
      readProjectFile,
      listRefs,
    }),
  };
}

describe("createVoiceMobileStartDefaultsResolver", () => {
  it("uses durable project defaults and returns canonical local task settings", async () => {
    const test = harness({
      serverConfig: config({ envMode: "worktree" }),
      projectFile: '{"defaultThreadEnvMode":"worktree"}',
    });
    const target = project({
      defaultThreadEnvMode: "local",
      defaultModelSelection: model("project-model", [{ id: "reasoningEffort", value: "high" }]),
    });

    await expect(test.resolver({ project: target })).resolves.toEqual({
      modelSelection: model("project-model", [{ id: "reasoningEffort", value: "high" }]),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      workspace: { mode: "local", branch: null, worktreePath: null },
    });
    expect(test.readTargetServerConfig).toHaveBeenCalledExactlyOnceWith(ENVIRONMENT_ID);
    expect(test.readProjectFile).not.toHaveBeenCalled();
    expect(test.listRefs).not.toHaveBeenCalled();
  });

  it("resolves t3.json before the target environment setting and prefers its default ref", async () => {
    const test = harness({
      serverConfig: config({ envMode: "local", startFromOrigin: false }),
      projectFile: '{"defaultThreadEnvMode":"worktree"}',
      refs: [
        ref("origin/main", { isDefault: true, isRemote: true }),
        ref("feature/current", { current: true }),
      ],
    });

    await expect(test.resolver({ project: project() })).resolves.toEqual({
      modelSelection: model("config-default"),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      workspace: {
        mode: "worktree",
        baseBranch: "origin/main",
        startFromOrigin: false,
      },
    });
    expect(test.readProjectFile).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: { cwd: "/workspace/mobile", relativePath: "t3.json" },
    });
    expect(test.listRefs).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: { cwd: "/workspace/mobile", limit: 100 },
    });
  });

  it("falls through invalid project model/file data to server defaults and a local current ref", async () => {
    const test = harness({
      serverConfig: config({ envMode: "worktree" }),
      projectFile: '{"defaultThreadEnvMode":"invalid"}',
      refs: [
        ref("origin/topic", { current: true, isRemote: true }),
        ref("topic", { current: true }),
      ],
    });

    await expect(
      test.resolver({
        project: project({ defaultModelSelection: model("removed-model") }),
      }),
    ).resolves.toMatchObject({
      modelSelection: model("config-default"),
      workspace: { mode: "worktree", baseBranch: "topic" },
    });
  });

  it("uses the first real model when neither project nor provider marks a default", async () => {
    const test = harness({
      serverConfig: config({
        providers: [provider({ models: [{ slug: "first-real" }, { slug: "second-real" }] })],
      }),
    });

    await expect(test.resolver({ project: project() })).resolves.toMatchObject({
      modelSelection: model("first-real"),
    });
  });

  it("fails closed when the target environment or real model is unavailable", async () => {
    const unavailable = harness({ serverConfig: null });
    await expect(unavailable.resolver({ project: project() })).rejects.toMatchObject({
      reason: "target-environment-unavailable",
    });
    expect(unavailable.readProjectFile).not.toHaveBeenCalled();

    const noModel = harness({ serverConfig: config({ providers: [provider({ models: [] })] }) });
    await expect(noModel.resolver({ project: project() })).rejects.toMatchObject({
      reason: "model-unavailable",
    });
  });

  it("rejects a disabled provider", async () => {
    const test = harness({
      serverConfig: config({
        providers: [provider({ models: [{ slug: "model" }], enabled: false })],
      }),
    });

    await expect(test.resolver({ project: project() })).rejects.toMatchObject({
      reason: "provider-unavailable",
    });
  });

  it("rejects an uninstalled provider", async () => {
    const test = harness({
      serverConfig: config({
        providers: [provider({ models: [{ slug: "model" }], installed: false })],
      }),
    });

    await expect(test.resolver({ project: project() })).rejects.toMatchObject({
      reason: "provider-unavailable",
    });
  });

  it("rejects an unauthenticated provider", async () => {
    const test = harness({
      serverConfig: config({
        providers: [provider({ models: [{ slug: "model" }], authStatus: "unauthenticated" })],
      }),
    });

    await expect(test.resolver({ project: project() })).rejects.toMatchObject({
      reason: "provider-unavailable",
    });
  });

  it("fails closed when live Git refs cannot establish a worktree base", async () => {
    const unavailable = harness({ serverConfig: config({ envMode: "worktree" }) });
    unavailable.listRefs.mockRejectedValueOnce(new Error("connection lost"));
    await expect(unavailable.resolver({ project: project() })).rejects.toEqual(
      new VoiceMobileStartDefaultsUnavailableError("git-unavailable"),
    );

    const noBase = harness({
      serverConfig: config({ envMode: "worktree" }),
      refs: [ref("topic")],
    });
    await expect(noBase.resolver({ project: project() })).rejects.toMatchObject({
      reason: "worktree-base-unavailable",
    });

    const notRepo = harness({
      serverConfig: config({ envMode: "worktree" }),
      refs: [ref("main", { isDefault: true })],
      isRepo: false,
    });
    await expect(notRepo.resolver({ project: project() })).rejects.toMatchObject({
      reason: "worktree-base-unavailable",
    });
  });
});

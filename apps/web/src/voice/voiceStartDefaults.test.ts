import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import {
  createVoiceStartDefaultsResolver,
  VoiceStartDefaultsUnavailableError,
  type VoiceStartDefaultsResolverDependencies,
} from "./voiceStartDefaults";

const NOW = "2026-08-11T10:00:00.000Z";
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-local");
const THREAD_ID = ThreadId.make("thread-current");
const DRAFT_ID = DraftId.make("draft-current");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

function selectDescriptor(
  id: string,
  values: ReadonlyArray<{ readonly id: string; readonly isDefault?: boolean }>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  const defaultValue = values.find((value) => value.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: values.map((value) => ({ id: value.id, label: value.id })),
    ...(defaultValue ? { currentValue: defaultValue } : {}),
  };
}

function provider(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly models?: ReadonlyArray<{
    readonly slug: string;
    readonly descriptors?: ReadonlyArray<ProviderOptionDescriptor>;
  }>;
  readonly enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: (input.models ?? []).map(({ slug, descriptors }) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: descriptors ? { optionDescriptors: descriptors } : {},
    })),
    slashCommands: [],
    skills: [],
  };
}

const CODEX_MODEL = "gpt-5.4";
const CLAUDE_MODEL = "claude-opus-4-6";
const PROVIDERS = [
  provider({
    instanceId: CODEX,
    driver: CODEX_DRIVER,
    models: [{ slug: CODEX_MODEL }],
  }),
  provider({
    instanceId: CLAUDE,
    driver: CLAUDE_DRIVER,
    models: [
      {
        slug: CLAUDE_MODEL,
        descriptors: [selectDescriptor("effort", [{ id: "low" }, { id: "high", isDefault: true }])],
      },
    ],
  }),
] satisfies ReadonlyArray<ServerProvider>;

const CODEX_SELECTION = {
  instanceId: CODEX,
  model: CODEX_MODEL,
} satisfies ModelSelection;

function project(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: ENVIRONMENT_ID,
    id: PROJECT_ID,
    title: "T3 Code",
    workspaceRoot: "/workspace/t3",
    repositoryIdentity: null,
    defaultModelSelection: CODEX_SELECTION,
    defaultThreadEnvMode: "local",
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function settings(overrides: Partial<UnifiedSettings> = {}): UnifiedSettings {
  return { ...DEFAULT_UNIFIED_SETTINGS, ...overrides };
}

function makeDependencies(
  overrides: Partial<VoiceStartDefaultsResolverDependencies> = {},
): VoiceStartDefaultsResolverDependencies {
  return {
    getCurrentRouteTarget: () => null,
    readComposerDraft: () => null,
    readThreadShell: () => null,
    readDraftSession: () => null,
    readStickyModelState: () => ({
      activeProvider: null,
      modelSelectionByProvider: {},
    }),
    readTargetEnvironment: () => ({
      providers: PROVIDERS,
      settings: settings({ planModeEnabled: true }),
    }),
    readPrimaryThreadDefaults: () => ({
      defaultThreadEnvMode: "local",
      newWorktreesStartFromOrigin: true,
    }),
    readProjectFileDefaultThreadEnvMode: async () => null,
    readGitState: async () => ({
      isRepo: true,
      currentBranch: "feature/current",
      refs: [],
    }),
    ...overrides,
  };
}

describe("createVoiceStartDefaultsResolver", () => {
  it("carries the routed composer model, exact options, runtime, and interaction mode", async () => {
    const threadRef = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);
    const carriedSelection = {
      instanceId: CLAUDE,
      model: CLAUDE_MODEL,
      options: [{ id: "effort", value: "low" }],
    } satisfies ModelSelection;
    const readComposerDraft = vi.fn(() => ({
      activeProvider: CLAUDE,
      modelSelectionByProvider: { [CLAUDE]: carriedSelection },
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    }));
    const readProjectFileDefaultThreadEnvMode = vi.fn(async () => "worktree" as const);
    const resolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        getCurrentRouteTarget: () => ({ kind: "server", threadRef }),
        readComposerDraft,
        readThreadShell: () => ({
          modelSelection: CODEX_SELECTION,
          runtimeMode: "auto",
          interactionMode: "default",
        }),
        readStickyModelState: () => ({
          activeProvider: CODEX,
          modelSelectionByProvider: { [CODEX]: CODEX_SELECTION },
        }),
        readProjectFileDefaultThreadEnvMode,
      }),
    );

    await expect(resolver({ project: project() })).resolves.toEqual({
      modelSelection: carriedSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspace: { mode: "local", branch: null, worktreePath: null },
    });
    expect(readComposerDraft).toHaveBeenCalledWith(threadRef);
    expect(readProjectFileDefaultThreadEnvMode).not.toHaveBeenCalled();
  });

  it("falls back through the routed shell and forces default interaction when plan mode is off", async () => {
    const threadRef = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);
    const resolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        getCurrentRouteTarget: () => ({ kind: "server", threadRef }),
        readComposerDraft: () => ({
          activeProvider: null,
          modelSelectionByProvider: {},
          runtimeMode: null,
          interactionMode: null,
        }),
        readThreadShell: () => ({
          modelSelection: CODEX_SELECTION,
          runtimeMode: "auto-accept-edits",
          interactionMode: "plan",
        }),
        readTargetEnvironment: () => ({
          providers: PROVIDERS,
          settings: settings({ planModeEnabled: false }),
        }),
      }),
    );

    await expect(resolver({ project: project() })).resolves.toMatchObject({
      modelSelection: CODEX_SELECTION,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
    });
  });

  it("uses sticky model state and routed draft modes when no composer override exists", async () => {
    const resolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        getCurrentRouteTarget: () => ({ kind: "draft", draftId: DRAFT_ID }),
        readDraftSession: () => ({
          runtimeMode: "auto",
          interactionMode: "plan",
        }),
        readStickyModelState: () => ({
          activeProvider: CLAUDE,
          modelSelectionByProvider: { [CLAUDE]: { instanceId: CLAUDE, model: CLAUDE_MODEL } },
        }),
      }),
    );

    await expect(resolver({ project: project() })).resolves.toMatchObject({
      modelSelection: { instanceId: CLAUDE, model: CLAUDE_MODEL },
      runtimeMode: "auto",
      interactionMode: "plan",
    });
  });

  it("resolves env mode project then t3.json then primary and preserves start-from-origin", async () => {
    const fileReader = vi.fn(async () => "worktree" as const);
    const gitReader = vi.fn(async () => ({
      isRepo: true,
      currentBranch: "feature/current",
      refs: [
        { name: "feature/current", current: true, isDefault: false },
        { name: "origin/main", current: false, isDefault: true },
      ],
    }));
    const projectResolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readProjectFileDefaultThreadEnvMode: fileReader,
        readGitState: gitReader,
        readPrimaryThreadDefaults: () => ({
          defaultThreadEnvMode: "local",
          newWorktreesStartFromOrigin: false,
        }),
      }),
    );

    await expect(
      projectResolver({ project: project({ defaultThreadEnvMode: "worktree" }) }),
    ).resolves.toMatchObject({
      workspace: { mode: "worktree", baseBranch: "origin/main", startFromOrigin: false },
    });
    expect(fileReader).not.toHaveBeenCalled();

    const fileResolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readProjectFileDefaultThreadEnvMode: fileReader,
        readGitState: gitReader,
        readPrimaryThreadDefaults: () => ({
          defaultThreadEnvMode: "local",
          newWorktreesStartFromOrigin: true,
        }),
      }),
    );
    await expect(
      fileResolver({ project: project({ defaultThreadEnvMode: null }) }),
    ).resolves.toMatchObject({
      workspace: { mode: "worktree", baseBranch: "origin/main", startFromOrigin: true },
    });
    expect(fileReader).toHaveBeenCalledWith(ENVIRONMENT_ID, "/workspace/t3");

    const primaryResolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readProjectFileDefaultThreadEnvMode: async () => null,
        readPrimaryThreadDefaults: () => ({
          defaultThreadEnvMode: "worktree",
          newWorktreesStartFromOrigin: false,
        }),
        readGitState: gitReader,
      }),
    );
    await expect(
      primaryResolver({ project: project({ defaultThreadEnvMode: null }) }),
    ).resolves.toMatchObject({
      workspace: { mode: "worktree", baseBranch: "origin/main", startFromOrigin: false },
    });
  });

  it("falls back from the default ref to the current branch and then the current ref", async () => {
    const byCurrentBranch = createVoiceStartDefaultsResolver(
      makeDependencies({
        readGitState: async () => ({
          isRepo: true,
          currentBranch: "feature/status",
          refs: [{ name: "feature/ref", current: true, isDefault: false }],
        }),
      }),
    );
    await expect(
      byCurrentBranch({ project: project({ defaultThreadEnvMode: "worktree" }) }),
    ).resolves.toMatchObject({ workspace: { baseBranch: "feature/status" } });

    const byCurrentRef = createVoiceStartDefaultsResolver(
      makeDependencies({
        readGitState: async () => ({
          isRepo: true,
          currentBranch: null,
          refs: [{ name: "feature/ref", current: true, isDefault: false }],
        }),
      }),
    );
    await expect(
      byCurrentRef({ project: project({ defaultThreadEnvMode: "worktree" }) }),
    ).resolves.toMatchObject({ workspace: { baseBranch: "feature/ref" } });
  });

  it("degrades a configured worktree to local for a non-repository project", async () => {
    const resolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readGitState: async () => ({ isRepo: false, currentBranch: null, refs: [] }),
      }),
    );

    await expect(
      resolver({ project: project({ defaultThreadEnvMode: "worktree" }) }),
    ).resolves.toMatchObject({
      workspace: { mode: "local", branch: null, worktreePath: null },
    });
  });

  it("fails closed without a real enabled provider or model", async () => {
    const disabledProviderResolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readTargetEnvironment: () => ({
          providers: [provider({ instanceId: CODEX, driver: CODEX_DRIVER, models: [] })],
          settings: settings({
            providers: {
              ...DEFAULT_UNIFIED_SETTINGS.providers,
              codex: { ...DEFAULT_UNIFIED_SETTINGS.providers.codex, enabled: false },
            },
          }),
        }),
      }),
    );
    await expect(disabledProviderResolver({ project: project() })).rejects.toMatchObject({
      reason: "provider-unavailable",
    } satisfies Partial<VoiceStartDefaultsUnavailableError>);

    const missingModelResolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readTargetEnvironment: () => ({
          providers: [provider({ instanceId: CODEX, driver: CODEX_DRIVER, models: [] })],
          settings: settings(),
        }),
      }),
    );
    await expect(missingModelResolver({ project: project() })).rejects.toMatchObject({
      reason: "model-unavailable",
    } satisfies Partial<VoiceStartDefaultsUnavailableError>);
  });

  it("fails closed when worktree git state or a base branch is unavailable", async () => {
    const unavailableGitResolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readGitState: async () => {
          throw new Error("offline");
        },
      }),
    );
    await expect(
      unavailableGitResolver({ project: project({ defaultThreadEnvMode: "worktree" }) }),
    ).rejects.toMatchObject({ reason: "git-unavailable" });

    const missingBaseResolver = createVoiceStartDefaultsResolver(
      makeDependencies({
        readGitState: async () => ({ isRepo: true, currentBranch: null, refs: [] }),
      }),
    );
    await expect(
      missingBaseResolver({ project: project({ defaultThreadEnvMode: "worktree" }) }),
    ).rejects.toMatchObject({ reason: "worktree-base-unavailable" });
  });
});

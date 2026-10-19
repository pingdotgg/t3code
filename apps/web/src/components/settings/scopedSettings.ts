import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type EnvironmentId,
  isNullableProjectSettingsOverride,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  ServerSettings,
  type T3ProjectFile,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
  resolveWorktreeCleanup,
  type ProjectSettingSource,
} from "@t3tools/shared/projectSettings";
import * as Equal from "effect/Equal";
import * as Cause from "effect/Cause";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly settings: ServerSettings;
    readonly environment?: {
      readonly capabilities: { readonly projectSettingsOverrides?: boolean | undefined };
    };
  } | null;
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));
const PROJECT_SCOPED_KEYS = new Set<string>(PROJECT_SCOPED_SERVER_SETTING_KEYS);

export function isProjectScopedSettingKey(key: string): key is ProjectScopedServerSettingKey {
  return PROJECT_SCOPED_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConnectedWithConfig(
  environment: Pick<ScopedSettingsEnvironment, "connection" | "serverConfig">,
) {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

/** The representative supplies display values, never the set of write targets. */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(isConnectedWithConfig);
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, environment };
}

export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<ProjectScopedServerSettingKey, ProjectSettingSource>>;
}

export function resolveScopedSettingsTargets(
  scope: ResolvedSettingsScope,
  connectedEnvironments: readonly ScopedSettingsEnvironment[],
  // A member absent here has no file tier yet; null is a missing or invalid file.
  projectFiles?: ReadonlyMap<string, T3ProjectFile | null>,
): readonly ScopedSettingsTarget[] {
  const byId = new Map(
    connectedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.flatMap((member) => {
      const environment = byId.get(member.environmentId);
      if (!environment?.serverConfig) return [];
      const projectFile = projectFiles?.get(member.physicalProjectKey);
      const resolved =
        projectFile === undefined
          ? resolveProjectSettings(environment.serverConfig.settings, member.id)
          : resolveProjectSettings(environment.serverConfig.settings, member.id, null, projectFile);
      return [
        {
          environmentId: member.environmentId,
          label: environment.label,
          projectId: member.id,
          settings: resolved.settings,
          sources: resolved.sources,
        },
      ];
    });
  }
  return connectedEnvironments.flatMap((environment) =>
    environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            projectId: null,
            settings: environment.serverConfig.settings,
            sources: resolveProjectSettings(environment.serverConfig.settings, null).sources,
          },
        ]
      : [],
  );
}

export function scopedSettingsAreMixed(
  targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  keys: readonly (keyof ServerSettings)[],
): boolean {
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some((candidate) =>
      keys.some((key) => !Equal.equals(first.settings[key], candidate.settings[key])),
    )
  );
}

export type ScopedSettingSource = ProjectSettingSource | "mixed";

export function scopedSettingsSource(
  targets: readonly Pick<ScopedSettingsTarget, "sources">[],
  keys: readonly (keyof ServerSettings)[],
): ScopedSettingSource {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0 || targets.length === 0) return "environment";
  const sources = new Set(targets.flatMap((target) => scoped.map((key) => target.sources[key])));
  return sources.size > 1
    ? "mixed"
    : sources.has("project")
      ? "project"
      : sources.has("t3.json")
        ? "t3.json"
        : "environment";
}

interface ScopedServerWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
  readonly previous: ServerSettings;
}

function projectOverrideWrites(
  scope: Extract<ResolvedSettingsScope, { kind: "project" | "checkout" }>,
  environments: readonly ScopedSettingsEnvironment[],
  update: (
    current: ProjectSettingsOverrides,
    settings: ServerSettings,
    projectId: ProjectId,
  ) => ProjectSettingsOverrides | null,
): ScopedServerWrite[] {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const member of scope.members) {
    const environment = byId.get(member.environmentId);
    if (
      !environment?.serverConfig ||
      environment.connection.phase !== "connected" ||
      environment.serverConfig.environment?.capabilities.projectSettingsOverrides !== true
    ) {
      continue;
    }
    const settings = environment.serverConfig.settings;
    const entry = update(settings.projectSettingsOverrides[member.id] ?? {}, settings, member.id);
    const existing = writes.get(member.environmentId);
    writes.set(member.environmentId, {
      environmentId: member.environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [member.id]: entry,
        },
      },
    });
  }
  return [...writes.values()];
}

export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ScopedSettingsPatch,
) {
  const clientPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => CLIENT_KEYS.has(key) && !SERVER_KEYS.has(key)),
  ) as ClientSettingsPatch;
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const serverKeys = Object.keys(serverPatch);
  const { connectedEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unscopableKeys = isProjectScope
    ? serverKeys.filter((key) => !isProjectScopedSettingKey(key))
    : [];
  const serverWrites: ScopedServerWrite[] =
    serverKeys.length === 0
      ? []
      : isProjectScope
        ? unscopableKeys.length > 0
          ? []
          : projectOverrideWrites(scope, environments, (current, settings, projectId) => {
              // Object-valued keys arrive as partial patches (the writing style
              // rows send one field); an override entry stores the whole value,
              // so complete the patch from the target's effective value.
              const effective = resolveProjectSettings(settings, projectId).settings;
              const next: Record<string, unknown> = { ...current };
              for (const [key, value] of Object.entries<unknown>(serverPatch)) {
                if (key === "worktreeCleanup" && serverPatch.worktreeCleanup?.mode === "custom") {
                  next[key] = {
                    mode: "custom",
                    rules: {
                      ...resolveWorktreeCleanup(settings, projectId),
                      ...serverPatch.worktreeCleanup.rules,
                    },
                  };
                  continue;
                }
                // A picker's "Inherit" sends null; for keys whose override
                // cannot store null that means remove the override.
                if (
                  value === null &&
                  !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey)
                ) {
                  delete next[key];
                  continue;
                }
                const base: unknown = effective[key as keyof ServerSettings];
                // A new model must not inherit the previous model's options.
                if (
                  isPlainObject(value) &&
                  isPlainObject(base) &&
                  (key === "defaultModelSelection" ||
                    key === "sourceControlWriterModelSelection" ||
                    key === "reviewGuideModelSelection" ||
                    key === "textGenerationModelSelection") &&
                  (value.instanceId !== undefined || value.model !== undefined)
                ) {
                  next[key] = { instanceId: base.instanceId, model: base.model, ...value };
                  continue;
                }
                next[key] =
                  isPlainObject(value) && isPlainObject(base) ? { ...base, ...value } : value;
              }
              return next as ProjectSettingsOverrides;
            })
        : scope.kind === "all" || scope.kind === "environment"
          ? connectedEnvironments.flatMap((environment) => {
              const previous = environment.serverConfig?.settings;
              if (!previous) return [];
              return [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  previous,
                  patch:
                    previous.worktreeCleanup != null &&
                    serverPatch.storageCleanup &&
                    Object.keys(serverPatch.storageCleanup).some((key) =>
                      key.startsWith("worktree"),
                    )
                      ? {
                          ...serverPatch,
                          worktreeCleanup: {
                            mode: "custom",
                            rules: {
                              ...resolveWorktreeCleanup(previous, null),
                              ...Object.fromEntries(
                                Object.entries(serverPatch.storageCleanup).filter(([key]) =>
                                  key.startsWith("worktree"),
                                ),
                              ),
                            },
                          },
                        }
                      : serverPatch,
                },
              ];
            })
          : [];
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || serverWrites.length > 0;
  const unavailableReason =
    hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : unscopableKeys.length > 0
          ? "This setting is environment-wide and cannot be overridden by a project."
          : isProjectScope
            ? "Connect the selected checkouts, or update their environments, to save a project override."
            : `Connect ${scope.kind === "environment" ? scope.label : "an environment"} to save this setting.`;
  return { clientPatch, hasClientWrite, serverWrites, unavailableReason };
}

export function planScopedSettingsClear(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const serverWrites =
    scope.kind === "project" || scope.kind === "checkout"
      ? projectOverrideWrites(scope, environments, (_current, settings, projectId) =>
          clearProjectSettingsOverrides(settings, projectId, keys),
        )
      : [];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0
        ? null
        : "Connect the selected checkouts, or update their environments, to reset this override.",
  };
}

export interface ProjectOverrideEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function listProjectOverrides(
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly (keyof ServerSettings)[],
): readonly ProjectOverrideEntry[] {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0) return [];
  return environments.flatMap((environment) => {
    const overrides = environment.serverConfig?.settings.projectSettingsOverrides;
    if (!overrides) return [];
    return Object.entries(overrides).flatMap(([projectId, entry]) =>
      scoped.some((key) => Object.hasOwn(entry, key))
        ? [{ environmentId: environment.environmentId, projectId: projectId as ProjectId }]
        : [],
    );
  });
}

export function planProjectOverridesClear(
  environments: readonly ScopedSettingsEnvironment[],
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const { environmentId, projectId } of entries) {
    const environment = byId.get(environmentId);
    if (!environment?.serverConfig || environment.connection.phase !== "connected") continue;
    const settings = environment.serverConfig.settings;
    const existing = writes.get(environmentId);
    writes.set(environmentId, {
      environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [projectId]: clearProjectSettingsOverrides(settings, projectId, keys),
        },
      },
    });
  }
  const serverWrites = [...writes.values()];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0 ? null : "Connect the environments to reset these overrides.",
  };
}

function writeWasDropped(value: unknown, before: unknown, saved: unknown): boolean {
  if (value === null) return before != null && Equal.equals(saved, before);
  if (isPlainObject(value) && !Array.isArray(before) && !Array.isArray(saved)) {
    const field = (source: unknown, key: string) =>
      isPlainObject(source) ? source[key] : undefined;
    return Object.entries(value).some(([key, next]) =>
      writeWasDropped(next, field(before, key), field(saved, key)),
    );
  }
  const unchanged =
    typeof value === "string" && typeof before === "string"
      ? value.trim() === before
      : Equal.equals(value, before);
  return !unchanged && Equal.equals(saved, before);
}

/**
 * An older server drops keys it does not know, top-level or nested, and still
 * succeeds. Left unreported, the row stays mixed forever.
 */
function droppedSettingKeys(write: ScopedServerWrite, saved: ServerSettings | undefined) {
  if (saved === undefined) return [];
  return Object.entries(write.patch).flatMap(([key, value]) =>
    writeWasDropped(
      value,
      write.previous[key as keyof ServerSettings],
      saved[key as keyof ServerSettings],
    )
      ? [key]
      : [],
  );
}

export async function persistScopedSettingsPatch(
  plan: ReturnType<typeof planScopedSettingsPatch>,
  persistServer: (input: {
    environmentId: EnvironmentId;
    input: { patch: ServerSettingsPatch };
  }) => Promise<{
    readonly _tag: "Success" | "Failure";
    readonly cause?: Cause.Cause<unknown>;
    readonly value?: ServerSettings;
  }>,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const results = await Promise.allSettled(
    plan.serverWrites.map(({ environmentId, patch }) =>
      persistServer({ environmentId, input: { patch } }),
    ),
  );
  const saved = (index: number) => {
    const result = results[index];
    return (
      result?.status === "fulfilled" &&
      result.value._tag === "Success" &&
      droppedSettingKeys(plan.serverWrites[index]!, result.value.value).length === 0
    );
  };
  const failedEnvironments = plan.serverWrites.flatMap((environment, index) => {
    if (saved(index)) return [];
    const result = results[index];
    if (result?.status === "fulfilled" && result.value._tag === "Success") {
      return [
        {
          ...environment,
          message: "This environment does not support this setting. Update T3 Code on it.",
        },
      ];
    }
    const error: unknown =
      result?.status === "rejected"
        ? result.reason
        : result?.status === "fulfilled" && result.value.cause
          ? Cause.squash(result.value.cause)
          : undefined;
    return [
      {
        ...environment,
        message:
          error instanceof Error
            ? error.message
            : "The save failed. Try reconnecting and saving again.",
      },
    ];
  });
  const savedEnvironments = plan.serverWrites.filter((_, index) => saved(index));
  return {
    failedEnvironments,
    savedEnvironments,
    savedEnvironmentCount: savedEnvironments.length,
  };
}

import {
  type CustomModelSetting,
  CustomModelSetting as CustomModelSettingSchema,
  type DelegationCandidate,
  DelegationTierId,
  type DelegationTiers,
  globalIdleCompaction,
  KeybindingCommand,
  type KeybindingsConfigError,
  OrchestratorMcpFailure,
  MAX_SCRIPT_ID_LENGTH,
  STATIC_KEYBINDING_COMMANDS,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
  shouldRecommendDatabaseCompaction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as CloudLink from "../../../cloud/CloudLink.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import { runtimeModeRank } from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as DatabaseStorage from "../../../persistence/DatabaseStorage.ts";
import { BUILT_IN_DRIVERS } from "../../../provider/builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "../../../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { providerUnavailableReason } from "../../DelegationPolicy.ts";
import { hiddenModelMessage } from "../../ModelVisibility.ts";
import * as Settings from "../../../serverSettings.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveRuntimeMode } from "../../delegatedTaskModes.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

const isCustomModelList = Schema.is(Schema.Array(CustomModelSettingSchema));
const configRecord = (config: unknown): Record<string, unknown> =>
  typeof config === "object" && config !== null && !Array.isArray(config) ? { ...config } : {};
const storedCustomModels = (config: unknown): ReadonlyArray<CustomModelSetting> => {
  const models = configRecord(config).customModels;
  return isCustomModelList(models) ? models : [];
};
const customModelSlug = (model: CustomModelSetting) =>
  typeof model === "string" ? model : model.slug;

/** The driver schema's own `customModels` guard; undefined when it has none or is unknown. */
const customModelsGuard = (driver: ProviderDriverKind) => {
  const ast = BUILT_IN_DRIVERS.find((candidate) => candidate.driverKind === driver)?.configSchema
    .ast;
  const property =
    ast?._tag === "Objects"
      ? ast.propertySignatures.find((signature) => signature.name === "customModels")
      : undefined;
  return property === undefined ? undefined : Schema.is(Schema.make<Schema.Top>(property.type));
};

function providerInstanceView(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
) {
  return {
    driver: instance.driver,
    displayName: instance.displayName ?? null,
    accentColor: instance.accentColor ?? null,
    enabled: resolveProjectProviderInstanceEnabled(settings, null, instanceId),
    customModels: storedCustomModels(instance.config),
  };
}

/**
 * Replaces the custom model list and drops concurrency caps of removed slugs,
 * as the settings UI does. ponytail: a removed custom slug that shadows a
 * built-in model also loses that model's cap; check the live model list if
 * that matters.
 */
function withCustomModels(config: unknown, customModels: ReadonlyArray<CustomModelSetting>) {
  const next = configRecord(config);
  const caps = next.modelConcurrency;
  if (typeof caps === "object" && caps !== null && !Array.isArray(caps)) {
    const kept = new Set(customModels.map(customModelSlug));
    const pruned = configRecord(caps);
    for (const slug of storedCustomModels(config).map(customModelSlug)) {
      if (!kept.has(slug)) delete pruned[slug];
    }
    if (Object.keys(pruned).length > 0) next.modelConcurrency = pruned;
    else delete next.modelConcurrency;
  }
  next.customModels = customModels;
  return next;
}

/**
 * Every MCP output lands in a provider transcript, and `getSettings`
 * materializes secrets (provider API keys, sensitive environment values), so
 * handlers project fields explicitly and never return settings or a driver
 * config blob.
 */
export function preferences(settings: ServerSettings) {
  const {
    completionAudio,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
    sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge,
    t3AgentInstructions,
    claudeInstructionFiles,
    claudeAutoMemory,
    claudeGitContext,
    claudeSkillList,
    claudeContextLists,
    claudeHooks,
    sidebarAutoSettleKeepPullRequests,
    pullRequestMergeMethod,
    branchNamingMode,
    reviewGuidesEnabled,
    defaultAutoPull,
    removeAgentCreditsOnMerge,
    worktreeSubmodules,
    favorites,
    providerModelPreferences,
    defaultModelSelection,
    textGenerationModelSelection,
    sourceControlWriterModelSelection,
    reviewGuideModelSelection,
    snoozeLimitedThreads,
    autoResumeLimitedThreads,
    continueThreadsAfterServerUpdate,
    responseStreamingMode,
    defaultRuntimeMode,
    delegationTiers,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    completionAudio,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
    sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge,
    t3AgentInstructions,
    claudeInstructionFiles,
    claudeAutoMemory,
    claudeGitContext,
    claudeSkillList,
    claudeContextLists,
    claudeHooks,
    sidebarAutoSettleKeepPullRequests,
    pullRequestMergeMethod,
    branchNamingMode,
    reviewGuidesEnabled,
    defaultAutoPull,
    removeAgentCreditsOnMerge,
    worktreeSubmodules,
    favorites,
    providerModelPreferences,
    defaultModelSelection,
    textGenerationModelSelection,
    sourceControlWriterModelSelection,
    reviewGuideModelSelection,
    idleCompaction: globalIdleCompaction(settings),
    snoozeLimitedThreads,
    autoResumeLimitedThreads,
    continueThreadsAfterServerUpdate,
    responseStreamingMode,
    defaultRuntimeMode,
    delegationTiers,
    providerInstances: Record.map(
      deriveProviderInstanceConfigMap(settings),
      (instance, instanceId) => providerInstanceView(settings, instanceId, instance),
    ),
  };
}

// Explicit fields only: the link state also carries the linked account id and
// relay identifiers, which must not reach a provider transcript.
const connectSummary = Effect.gen(function* () {
  const cloud = yield* CloudLink.CloudLink;
  const state = yield* cloud.linkState();
  const reachability = state.reachability;
  return {
    linked: state.linked,
    linkRevoked: state.linkRevoked ?? false,
    managedTunnelActive: state.managedTunnelActive ?? false,
    publishAgentActivity: state.publishAgentActivity,
    holdWebhooksWhileOffline: state.holdWebhooksWhileOffline ?? false,
    reachability:
      reachability === undefined
        ? null
        : reachability.status === "reachable"
          ? { status: reachability.status, checkedAt: reachability.checkedAt }
          : {
              status: reachability.status,
              checkedAt: reachability.checkedAt,
              cause: reachability.cause,
            },
  };
}).pipe(
  // A secret-store read failure leaves Connect status unknown; the rest of the read stands.
  Effect.orElseSucceed(() => null),
);
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
/**
 * Runs an environment write under the calling thread's lock. `check` runs
 * again once the lock is held: the turn may have ended, or the thread's modes
 * changed, while this waited.
 */
const underCallerLock = Effect.fn("EnvironmentToolkit.underCallerLock")(function* <A, E, R, E2, R2>(
  check: Effect.Effect<unknown, E2, R2>,
  write: Effect.Effect<A, E, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const update = Effect.andThen(check, write);
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});
// The error's own message embeds the config path; `detail` is a fixed description.
const keybindingsFailure = (error: KeybindingsConfigError) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `Keybindings config: ${error.detail}.`,
  });
// Tool parameters accept any non-empty command string; the contract schema is
// the source of truth and is checked here, before any write.
const decodeKeybindingCommand = Schema.decodeUnknownEffect(KeybindingCommand);
const keybindingCommand = (command: string) =>
  decodeKeybindingCommand(command).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          // The ids come straight from the contract's static set, so the message
          // cannot drift from what the schema accepts; the set is closed, which
          // keeps the message bounded.
          message: `Unknown keybinding command \`${command}\`. Valid commands: ${STATIC_KEYBINDING_COMMANDS.join(", ")}, or \`script.<id>.run\` for a project script (\`<id>\`: lowercase letters, digits and hyphens, at most ${MAX_SCRIPT_ID_LENGTH} characters).`,
        }),
    ),
  );
const keybindingsWrite = Effect.fn("EnvironmentToolkit.keybindingsWrite")(function* (
  write: (
    service: Keybindings.Keybindings["Service"],
  ) => Effect.Effect<Keybindings.KeybindingsConfigState, KeybindingsConfigError>,
) {
  yield* access;
  const service = yield* Keybindings.Keybindings;
  return yield* write(service).pipe(Effect.mapError(keybindingsFailure));
});
// A tier's quota guard is its candidates' minimum headroom; absent means 0.
const headroomThreshold = (candidate: DelegationCandidate) => candidate.minHeadroomPercent ?? 0;
// A tier may list the same provider+model twice (Settings allows it), so the
// k-th input entry for a provider+model pairs with the k-th stored one.
// Unpaired input entries are new; unpaired stored entries are being removed.
const pairWithStored = (
  candidates: ReadonlyArray<DelegationCandidate>,
  stored: ReadonlyArray<DelegationCandidate>,
) => {
  const unpaired: Array<DelegationCandidate | undefined> = [...stored];
  const paired = candidates.map((candidate) => {
    const index = unpaired.findIndex(
      (entry) =>
        entry !== undefined &&
        entry.providerInstanceId === candidate.providerInstanceId &&
        entry.model === candidate.model,
    );
    if (index === -1) return undefined;
    const previous = unpaired[index];
    unpaired[index] = undefined;
    return previous;
  });
  return {
    paired,
    removed: unpaired.filter((entry): entry is DelegationCandidate => entry !== undefined),
  };
};
// Headroom guards quota per provider instance within a tier, so agents may
// only raise it: a guarded stored entry can't be removed or lowered, and a new
// entry can't sit below a stored guard on its instance. Reordering is free.
const findsHeadroomLowering = (
  candidates: ReadonlyArray<DelegationCandidate>,
  stored: ReadonlyArray<DelegationCandidate>,
) => {
  const { paired, removed } = pairWithStored(candidates, stored);
  return (
    removed.some((previous) => headroomThreshold(previous) > 0) ||
    candidates.some((candidate, index) => {
      const previous = paired[index];
      return previous !== undefined
        ? headroomThreshold(candidate) < headroomThreshold(previous)
        : stored.some(
            (entry) =>
              entry.providerInstanceId === candidate.providerInstanceId &&
              headroomThreshold(candidate) < headroomThreshold(entry),
          );
    })
  );
};
/** The compact tool input omits `options`; keep the paired stored entry's selection. */
const withStoredOptions = (
  candidates: ReadonlyArray<DelegationCandidate>,
  stored: ReadonlyArray<DelegationCandidate>,
): Array<DelegationCandidate> => {
  const { paired } = pairWithStored(candidates, stored);
  return candidates.map((candidate, index): DelegationCandidate => {
    const options = paired[index]?.options;
    return options === undefined ? candidate : { ...candidate, options };
  });
};

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        connect: yield* connectSummary,
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    underCallerLock(
      check,
      Effect.gen(function* () {
        const { settings } = yield* access;
        const requested = patch.defaultRuntimeMode;
        if (requested !== undefined) {
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          yield* resolveRuntimeMode(current.defaultRuntimeMode, requested).pipe(
            Effect.mapError(
              (failure) =>
                new OrchestratorMcpFailure({
                  code: failure.code,
                  message:
                    "defaultRuntimeMode can only be lowered by agents; raise it in Settings.",
                }),
            ),
          );
        }
        const { setDelegationTier, ...rest } = patch;
        // Validated before the lock against live provider snapshots; the write
        // refuses if the tier changed meanwhile, so every check still holds.
        const tierOp =
          setDelegationTier === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
                const candidates = setDelegationTier.candidates ?? [];
                const tier: DelegationTierId = setDelegationTier.tier;
                const stored = current.delegationTiers[tier];
                const registry = yield* ProviderRegistry.ProviderRegistry;
                const providers = yield* Effect.mapError(registry.getProviders, unavailable);
                const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
                const orchestrationCapable = new Set(
                  yield* Effect.mapError(adapters.list(), unavailable),
                );
                const { paired } = pairWithStored(candidates, stored);
                for (const [index, candidate] of candidates.entries()) {
                  // Already stored: vetted when it was added, and a down or
                  // changed provider must not freeze edits to this tier.
                  if (paired[index] !== undefined) continue;
                  const provider = providers.find(
                    (entry) => entry.instanceId === candidate.providerInstanceId,
                  );
                  const reason = providerUnavailableReason(
                    provider,
                    orchestrationCapable.has(candidate.providerInstanceId),
                  );
                  if (reason !== undefined)
                    return yield* new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: `Delegation tier "${tier}" candidate ${candidate.providerInstanceId}/${candidate.model}: ${reason}. Pick a provider from orchestrator_capabilities.`,
                    });
                  if (
                    provider !== undefined &&
                    provider.models.length > 0 &&
                    !provider.models.some((model) => model.slug === candidate.model)
                  )
                    return yield* new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: `Delegation tier "${tier}" candidate ${candidate.providerInstanceId}/${candidate.model}: model is not advertised. Pick a model from orchestrator_capabilities.`,
                    });
                  const hidden = hiddenModelMessage({
                    settings: current,
                    providers,
                    selection: {
                      instanceId: candidate.providerInstanceId,
                      model: candidate.model,
                    },
                  });
                  if (hidden !== null)
                    return yield* new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: hidden,
                    });
                }
                if (findsHeadroomLowering(candidates, stored))
                  return yield* new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: `Delegation tier "${tier}": removing or lowering a guarded candidate's minimum headroom needs Settings; agents can only raise or keep it.`,
                  });
                return { tier, candidates, stored };
              });
        // The rank check repeats under the settings write lock so a human
        // lowering the default between the check above and the write is kept.
        // `before` reads the in-lock tier, not the pre-lock snapshot.
        let tierRefused = false;
        const tierApplied: Array<{
          tier: DelegationTierId;
          before: ReadonlyArray<DelegationCandidate>;
          after: ReadonlyArray<DelegationCandidate>;
        }> = [];
        const updated = yield* settings
          .modifySettings((current) => {
            const rankKept =
              requested === undefined ||
              runtimeModeRank[requested] <= runtimeModeRank[current.defaultRuntimeMode];
            const storedTier =
              tierOp === undefined ? undefined : current.delegationTiers[tierOp.tier];
            const tierDropped =
              tierOp === undefined ||
              storedTier === undefined ||
              JSON.stringify(storedTier) !== JSON.stringify(tierOp.stored);
            // A tier edited while the write waited fails the whole call:
            // silently writing the rest would hide the dropped tier from the
            // agent, and the tool input has no way to re-ask in place.
            if (tierOp !== undefined && tierDropped) {
              tierRefused = true;
              return {};
            }
            let tierTiers: DelegationTiers | undefined;
            if (tierOp !== undefined && storedTier !== undefined) {
              const after = withStoredOptions(tierOp.candidates, storedTier);
              tierApplied.push({ tier: tierOp.tier, before: storedTier, after });
              tierTiers = {
                ...current.delegationTiers,
                small: tierOp.tier === "small" ? after : current.delegationTiers.small,
                medium: tierOp.tier === "medium" ? after : current.delegationTiers.medium,
                large: tierOp.tier === "large" ? after : current.delegationTiers.large,
              };
            }
            if (!rankKept) {
              const { defaultRuntimeMode: _raised, ...lowered } = rest;
              return tierTiers === undefined ? lowered : { ...lowered, delegationTiers: tierTiers };
            }
            return tierTiers === undefined ? rest : { ...rest, delegationTiers: tierTiers };
          })
          .pipe(Effect.mapError(unavailable));
        if (tierRefused && tierOp !== undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Delegation tier "${tierOp.tier}" was edited while the write waited for its lock; nothing was written, retry.`,
          });
        const change = tierApplied.at(0);
        return {
          ...preferences(updated),
          ...(change === undefined ? {} : { delegationTierChange: change }),
        };
      }),
    ),
  ),
  t3_provider_instance_update: McpToolAccess.writesEnvironment(
    ({ instanceId, customModels, displayName, accentColor }, check) =>
      underCallerLock(
        check,
        Effect.gen(function* () {
          const { settings } = yield* access;
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          const known = deriveProviderInstanceConfigMap(current)[instanceId];
          if (known === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Unknown provider instance ${instanceId}.`,
            });
          // The settings UI never shows antigravity's list, so a write here would be invisible.
          const acceptsCustomModels =
            known.driver === "antigravity" ? undefined : customModelsGuard(known.driver);
          if (
            customModels !== undefined &&
            (acceptsCustomModels === undefined || !acceptsCustomModels(customModels))
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Provider instance ${instanceId} does not accept these custom models.`,
            });
          const updated = yield* settings
            .updateProviderInstance((stored) => {
              // Built from the persisted instance, so its environment and
              // stored secrets are carried over without being materialized.
              // Removed while this waited for the lock: removing again is a no-op.
              if (deriveProviderInstanceConfigMap(stored)[instanceId] === undefined)
                return { operation: "remove", instanceId };
              // Not the derived entry: a project override would make it enabled
              // environment-wide.
              const base = stored.providerInstances[instanceId] ?? { driver: known.driver };
              return {
                operation: "upsert",
                instanceId,
                instance: {
                  ...base,
                  displayName:
                    displayName === undefined ? base.displayName : (displayName ?? undefined),
                  accentColor:
                    accentColor === undefined ? base.accentColor : (accentColor ?? undefined),
                  ...(customModels === undefined
                    ? {}
                    : { config: withCustomModels(base.config, customModels) }),
                },
              };
            })
            .pipe(Effect.mapError(unavailable));
          const instance = deriveProviderInstanceConfigMap(updated)[instanceId];
          if (instance === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Provider instance ${instanceId} was removed.`,
            });
          return providerInstanceView(updated, instanceId, instance);
        }),
      ),
  ),
  t3_keybindings_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const service = yield* Keybindings.Keybindings;
      return yield* service.loadConfigState.pipe(Effect.mapError(keybindingsFailure));
    }),
  ),
  t3_keybinding_upsert: McpToolAccess.writesEnvironment((rule, check) =>
    underCallerLock(
      check,
      Effect.gen(function* () {
        const command = yield* keybindingCommand(rule.command);
        const replace =
          rule.replace === undefined
            ? undefined
            : { ...rule.replace, command: yield* keybindingCommand(rule.replace.command) };
        return yield* keybindingsWrite((service) =>
          service.upsertKeybindingRule({
            key: rule.key,
            command,
            ...(rule.when === undefined ? {} : { when: rule.when }),
            ...(replace === undefined ? {} : { replace }),
          }),
        );
      }),
    ),
  ),
  t3_keybinding_remove: McpToolAccess.writesEnvironment((rule, check) =>
    underCallerLock(
      check,
      Effect.gen(function* () {
        const command = yield* keybindingCommand(rule.command);
        return yield* keybindingsWrite((service) =>
          service.removeKeybindingRule({
            key: rule.key,
            command,
            ...(rule.when === undefined ? {} : { when: rule.when }),
          }),
        );
      }),
    ),
  ),
  // Totals only: cleanup entries carry paths and thread titles, and the
  // compact command embeds the base directory.
  t3_environment_storage_report: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const cleanup = yield* StorageCleanup.StorageCleanup;
      const database = yield* DatabaseStorage.DatabaseStorage;
      const status = Option.getOrNull(yield* Stream.runHead(database.status));
      const report = yield* cleanup.latestReport;
      return {
        database:
          status === null
            ? null
            : {
                databaseBytes: status.databaseBytes,
                reclaimableBytes: status.reclaimableBytes,
                incrementalVacuumEnabled: status.incrementalVacuumEnabled,
                compactionRecommended: shouldRecommendDatabaseCompaction(status),
              },
        lastCleanup:
          report === null
            ? null
            : {
                trigger: report.trigger,
                startedAt: report.startedAt,
                finishedAt: report.finishedAt,
                counts: report.counts,
                bytesFreed: report.bytesFreed,
                entryCount: report.entries.length + report.omittedCount,
              },
      };
    }),
  ),
});

import {
  ProjectId,
  type PrismModelPreference,
  type PrismRole,
  type PrismRoleKits,
  type PrismRoleKitsPatch,
  type PrismLane,
  type PrismSwitchableRole,
  type ModelCapabilities,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "../chat/providerIconUtils";
import { planScopedSettingsPatch } from "./scopedSettings";

export function prismModelKey(entry: Pick<PrismModelPreference, "instanceId" | "model">) {
  return JSON.stringify([entry.instanceId, entry.model]);
}

export function movePrismPreference<T extends PrismModelPreference>(
  models: readonly T[],
  index: number,
  direction: -1 | 1,
) {
  const destination = index + direction;
  if (index < 0 || index >= models.length || destination < 0 || destination >= models.length)
    return models;
  const next = [...models];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

export function prismEffortOptions(capabilities: ModelCapabilities | null | undefined) {
  const descriptor = capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" && ["effort", "reasoningEffort", "variant"].includes(option.id),
  );
  return descriptor?.type === "select"
    ? descriptor.options.filter((option) => !descriptor.promptInjectedValues?.includes(option.id))
    : [];
}

/** One autosaved edit on the Prism page. */
export type PrismRoleUpdate =
  | { kind: "lane"; role: "worker"; lane: PrismLane; models: readonly PrismModelPreference[] }
  | {
      kind: "models";
      role: Exclude<PrismRole, "worker">;
      models: readonly PrismModelPreference[];
    }
  | { kind: "enabled"; role: PrismSwitchableRole; enabled: boolean };

function prismRolePatch(update: PrismRoleUpdate): PrismRoleKitsPatch {
  switch (update.kind) {
    case "lane":
      return { worker: { lanes: { [update.lane]: update.models } } };
    case "models":
      return { [update.role]: { models: update.models } };
    case "enabled":
      return { [update.role]: { enabled: update.enabled } };
  }
}

function applyPrismRoleUpdate(kits: PrismRoleKits, update: PrismRoleUpdate): PrismRoleKits {
  switch (update.kind) {
    case "lane":
      return {
        ...kits,
        worker: { ...kits.worker, lanes: { ...kits.worker.lanes, [update.lane]: update.models } },
      };
    case "models":
      return { ...kits, [update.role]: { ...kits[update.role], models: update.models } };
    case "enabled":
      return { ...kits, [update.role]: { ...kits[update.role], enabled: update.enabled } };
  }
}

/** Project overrides store complete kits, while environment updates accept deep patches. */
export function planPrismRolePatch(
  scope: Parameters<typeof planScopedSettingsPatch>[0],
  environments: Parameters<typeof planScopedSettingsPatch>[1],
  update: PrismRoleUpdate,
): ReturnType<typeof planScopedSettingsPatch> {
  const plan = planScopedSettingsPatch(scope, environments, {
    prismRoles: prismRolePatch(update),
  });
  return {
    ...plan,
    serverWrites: plan.serverWrites.map((write) => {
      const overrides = write.patch.projectSettingsOverrides;
      const settings = environments.find((env) => env.environmentId === write.environmentId)
        ?.serverConfig?.settings;
      if (!overrides || !settings) return write;
      return {
        ...write,
        patch: {
          ...write.patch,
          projectSettingsOverrides: Object.fromEntries(
            Object.entries(overrides).map(([id, override]) => [
              id,
              {
                ...override,
                prismRoles: applyPrismRoleUpdate(
                  resolveProjectSettings(settings, ProjectId.make(id)).settings.prismRoles,
                  update,
                ),
              },
            ]),
          ),
        },
      };
    }),
  };
}

export function prismModelChoices(
  entries: readonly Pick<
    ProviderInstanceEntry,
    "instanceId" | "displayName" | "enabled" | "isAvailable" | "models"
  >[],
  options: ReadonlyMap<ProviderInstanceId, readonly ModelEsque[]>,
  disabledReason: (instanceId: ProviderInstanceId, model: string) => string | null,
) {
  return entries
    .filter((entry) => entry.enabled && entry.isAvailable)
    .flatMap((entry) =>
      (options.get(entry.instanceId) ?? [])
        .filter((model) => !model.isUnavailable && !disabledReason(entry.instanceId, model.slug))
        .map((model) => ({
          preference: { instanceId: entry.instanceId, model: model.slug },
          label: `${entry.displayName} / ${model.name}`,
          efforts: prismEffortOptions(
            entry.models.find((candidate) => candidate.slug === model.slug)?.capabilities,
          ),
        })),
    );
}

export type PrismWriteExpectation = PrismRoleUpdate | { kind: "inherit" };

/** A successful RPC is not enough: wait for the streamed settings before building another full override. */
export function prismWriteObserved(
  plan: ReturnType<typeof planScopedSettingsPatch>,
  environments: Parameters<typeof planScopedSettingsPatch>[1],
  expectation: PrismWriteExpectation,
) {
  return plan.serverWrites.every((write) => {
    const settings = environments.find((env) => env.environmentId === write.environmentId)
      ?.serverConfig?.settings;
    if (!settings) return false;
    const projectIds = Object.keys(write.patch.projectSettingsOverrides ?? {});
    if (expectation.kind === "inherit") {
      return projectIds.every(
        (id) => settings.projectSettingsOverrides[ProjectId.make(id)]?.prismRoles === undefined,
      );
    }
    const effective = projectIds.length
      ? projectIds.map((id) => resolveProjectSettings(settings, ProjectId.make(id)).settings)
      : [settings];
    return effective.every(
      (target) =>
        JSON.stringify(target.prismRoles[expectation.role]) ===
        JSON.stringify(applyPrismRoleUpdate(target.prismRoles, expectation)[expectation.role]),
    );
  });
}

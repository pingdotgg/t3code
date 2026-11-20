import type {
  DelegationCandidate,
  DelegationTierId,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { msg, T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettingsHydrated } from "../../hooks/useSettings";
import type { MessageResolver } from "../../i18n/messages";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const TIERS: ReadonlyArray<{
  readonly id: DelegationTierId;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "small",
    label: msg("Small", { $context: "delegation tier" }),
    description: msg("Retrieval, mechanical, cheap parallel work."),
  },
  {
    id: "medium",
    label: msg("Medium", { $context: "delegation tier" }),
    description: msg("General implementation."),
  },
  {
    id: "large",
    label: msg("Large", { $context: "delegation tier" }),
    description: msg("Critical work, planning, review."),
  },
];

/** Display approximation: the server matches windows per model when it resolves. */
function headroomLabel(
  limits: ServerProviderUsageLimits | undefined,
  resolve: MessageResolver,
): string {
  if (limits === undefined || limits.unavailable !== undefined || limits.windows.length === 0) {
    return resolve(msg("usage unknown"));
  }
  const usedPercent = Math.max(...limits.windows.map((window) => window.usedPercent));
  return resolve(msg("{percent}% left", { percent: Math.round(100 - usedPercent) }));
}

function CandidateRow({
  candidate,
  instanceEntries,
  providersByInstance,
  index,
  count,
  disabled,
  onMove,
  onRemove,
  onHeadroomCommit,
}: {
  readonly candidate: DelegationCandidate;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providersByInstance: ReadonlyMap<ProviderInstanceId, ServerProvider>;
  readonly index: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly onHeadroomCommit: (minHeadroomPercent: number | undefined) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  // Local draft so typing never saves per keystroke; the blur commits.
  const [headroomDraft, setHeadroomDraft] = useState<string | null>(null);
  const entry = instanceEntries.find((item) => item.instanceId === candidate.providerInstanceId);
  const provider = entry?.displayName ?? candidate.providerInstanceId;
  const headroom = headroomDraft ?? candidate.minHeadroomPercent?.toString() ?? "";

  const commitHeadroom = () => {
    if (headroomDraft === null) return;
    setHeadroomDraft(null);
    const trimmed = headroomDraft.trim();
    if (trimmed === "") {
      if (candidate.minHeadroomPercent !== undefined) onHeadroomCommit(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(100, Math.max(0, Math.round(parsed)));
    if (clamped !== candidate.minHeadroomPercent) onHeadroomCommit(clamped);
  };

  return (
    <SettingsRow
      title={provider}
      description={candidate.model}
      control={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Input
            size="sm"
            className="w-20"
            type="number"
            min={0}
            max={100}
            step={1}
            value={headroom}
            disabled={disabled}
            aria-label={gt("Minimum headroom percent for {provider} {model}", {
              provider,
              model: candidate.model,
            })}
            placeholder="-"
            onChange={(event) => setHeadroomDraft(event.currentTarget.value)}
            onBlur={commitHeadroom}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {headroomLabel(
              providersByInstance.get(candidate.providerInstanceId)?.usageLimits,
              resolve,
            )}
          </span>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            disabled={disabled || index === 0}
            aria-label={gt("Move {provider} {model} up", { provider, model: candidate.model })}
            onClick={onMove.bind(null, -1)}
          >
            <ChevronUpIcon className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            disabled={disabled || index === count - 1}
            aria-label={gt("Move {provider} {model} down", { provider, model: candidate.model })}
            onClick={onMove.bind(null, 1)}
          >
            <ChevronDownIcon className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            disabled={disabled}
            aria-label={gt("Remove {provider} {model} from tier", {
              provider,
              model: candidate.model,
            })}
            onClick={onRemove}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      }
    />
  );
}

export function DelegationSettingsPanel() {
  const gt = useGT();
  const resolve = useMessages();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const { environment, connectedEnvironments } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(textGenerationProviders, settings, null);
  // The picker keeps its own highlighted row across tiers; it starts on the
  // environment's default selection and follows the last candidate added.
  const defaultSelection = resolveAppModelSelectionState(settings, textGenerationProviders);
  const [pickerSelection, setPickerSelection] = useState<ModelSelection | null>(null);
  const activeSelection = pickerSelection ?? defaultSelection;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const providersByInstance = new Map(
    serverProviders.map((provider) => [provider.instanceId, provider] as const),
  );

  const updateTier = (tier: DelegationTierId, candidates: Array<DelegationCandidate>) => {
    updateSettings({ delegationTiers: { ...settings.delegationTiers, [tier]: candidates } });
  };

  if (connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("delegation")} variant="plain">
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            <T>Connect an environment to edit its delegation tiers.</T>
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("delegation")}>
        <SettingsRow
          title={gt("How tiers resolve")}
          description={gt(
            "A child spawned at a tier tries the tier's first candidate. Candidates whose provider is unavailable or whose remaining usage is below their minimum headroom are skipped for the next.",
          )}
        />
      </SettingsSection>
      {TIERS.map((tier) => {
        const candidates = settings.delegationTiers[tier.id];
        const label = resolve(tier.label);
        // Content keys survive reorders; an ordinal keeps duplicate entries unique.
        const seenCounts = new Map<string, number>();
        const rows = candidates.map((candidate) => {
          const base = JSON.stringify(candidate);
          const ordinal = seenCounts.get(base) ?? 0;
          seenCounts.set(base, ordinal + 1);
          return { candidate, key: `${base}:${ordinal}` };
        });
        return (
          <SettingsSection
            key={tier.id}
            id={`${tier.id}-tier`}
            title={label}
            headerAction={
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
                activeInstanceId={activeSelection.instanceId}
                model={activeSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                disabled={!settingsHydrated}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerLabel={gt("Add candidate")}
                triggerAriaLabel={gt("Add {tier} tier candidate", { tier: label })}
                onInstanceModelChange={(instanceId, model) => {
                  setPickerSelection(createModelSelection(instanceId, model));
                  updateTier(tier.id, [...candidates, { providerInstanceId: instanceId, model }]);
                }}
              />
            }
          >
            <p className="px-3 pt-0.5 pb-2.5 text-muted-foreground/80 text-sm leading-normal sm:px-4">
              {resolve(tier.description)}
            </p>
            {candidates.length === 0 ? (
              <SettingsRow
                title={gt("No candidates")}
                description={gt(
                  "Add a provider and model so spawns at this tier have somewhere to go.",
                )}
              />
            ) : (
              rows.map(({ candidate, key }, index) => (
                <CandidateRow
                  key={key}
                  candidate={candidate}
                  instanceEntries={instanceEntries}
                  providersByInstance={providersByInstance}
                  index={index}
                  count={candidates.length}
                  disabled={!settingsHydrated}
                  onMove={(delta) => {
                    const next = [...candidates];
                    const [moved] = next.splice(index, 1);
                    if (moved === undefined) return;
                    next.splice(index + delta, 0, moved);
                    updateTier(tier.id, next);
                  }}
                  onRemove={() => {
                    updateTier(
                      tier.id,
                      candidates.filter((_, candidateIndex) => candidateIndex !== index),
                    );
                  }}
                  onHeadroomCommit={(minHeadroomPercent) => {
                    updateTier(
                      tier.id,
                      candidates.map((item, candidateIndex) =>
                        candidateIndex === index
                          ? minHeadroomPercent === undefined
                            ? {
                                providerInstanceId: item.providerInstanceId,
                                model: item.model,
                                ...(item.options !== undefined ? { options: item.options } : {}),
                              }
                            : { ...item, minHeadroomPercent }
                          : item,
                      ),
                    );
                  }}
                />
              ))
            )}
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}

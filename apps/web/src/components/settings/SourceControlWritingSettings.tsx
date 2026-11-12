import { useChangeRequestTerms } from "~/hooks/useSettings";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  type ProviderInstanceId,
  type ServerSettings,
  type SourceControlWritingStyleMode,
  textGeneratorForSelection,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";

import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useTextGenerationTargets } from "../../textGenerators";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { AdvancedSettings } from "./AdvancedSettings";
import { searchableSetting } from "./settingsSearch";

const MODE_OPTIONS: Record<SourceControlWritingStyleMode, { label: string; description: string }> =
  {
    repo_conventions: {
      label: "Repository conventions",
      description:
        "Commit messages and pull request titles and descriptions match each project's history.",
    },
    conventional_commits: {
      label: "Conventional Commits",
      description: "Conventional Commit prefixes, with short pull request titles and descriptions.",
    },
    custom: {
      label: "Custom instructions",
      description:
        "Your instructions shape commit messages and pull request titles and descriptions.",
    },
  };

export function SourceControlWritingSettingsSection() {
  const requestTerms = useChangeRequestTerms();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedReviewGuidesEnabled = useScopedSettingsMixed(["reviewGuidesEnabled"]);
  const navigate = useNavigate();
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const styleFieldMixed = (field: keyof ServerSettings["sourceControlWritingStyle"]) => {
    const first = targets[0];
    return (
      first !== undefined &&
      targets.some(
        (candidate) =>
          candidate.settings.sourceControlWritingStyle[field] !==
          first.settings.sourceControlWritingStyle[field],
      )
    );
  };
  const modeMixed = styleFieldMixed("mode");
  const instructionsMixed = styleFieldMixed("customInstructions");
  const templatesMixed = styleFieldMixed("followChangeRequestTemplates");
  const writingStyleMixed = modeMixed || instructionsMixed;
  const mixedWriterModel = useScopedSettingsMixed(["sourceControlWriterModelSelection"]);
  const mixedReviewGuideModel = useScopedSettingsMixed(["reviewGuideModelSelection"]);
  const mixedReviewGuideInstructions = useScopedSettingsMixed(["reviewGuideInstructions"]);
  const reviewGuideInstructionsEdited = useRef(false);
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const [editingAllInstructions, setEditingAllInstructions] = useState(false);
  const [allInstructions, setAllInstructions] = useState<string | null>(null);
  const style = settings.sourceControlWritingStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const isSourceControlWritingStyleDirty =
    writingStyleMixed ||
    style.mode !== defaults.mode ||
    style.customInstructions !== defaults.customInstructions;

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  // Text generators may write source control text, but never review guides.
  const writerTargets = useTextGenerationTargets({
    environmentId,
    settings,
    providers: textGenerationProviders,
    projectId: target?.projectId ?? null,
    selections: [settings.sourceControlWriterModelSelection, settings.textGenerationModelSelection],
  });
  const writerEntries = writerTargets.entries;
  const projectEnabledInstanceIds = new Set(
    writerEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const projectEffectiveTextGenerationProviders = writerTargets.providers.filter((provider) =>
    projectEnabledInstanceIds.has(provider.instanceId),
  );
  const defaultModelSelection = resolveAppModelSelectionState(
    settings,
    projectEffectiveTextGenerationProviders,
  );
  const usesDedicatedModel = settings.sourceControlWriterModelSelection !== null;
  const activeSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSourceControlWriterModelSelection(
        settings,
        projectEffectiveTextGenerationProviders,
        target?.projectId ?? null,
      ),
    },
    projectEffectiveTextGenerationProviders,
  );
  const canEnableDedicatedModel = writerEntries.some(
    (entry) =>
      entry.instanceId === defaultModelSelection.instanceId && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    projectEffectiveTextGenerationProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const writerModelDisabledReason = useScopedModelDisabledReason(settings, writerEntries);
  const writerInstanceEntry = writerEntries.find(
    (entry) => entry.instanceId === activeSelection.instanceId,
  );
  const usesReviewGuideModel = settings.reviewGuideModelSelection !== null;
  // Resolve against agents this project can use, so the fallback never lands on one it turned off.
  const projectAgentProviders = textGenerationProviders.filter((provider) =>
    instanceEntries.some(
      (entry) => entry.instanceId === provider.instanceId && entry.enabled && entry.isAvailable,
    ),
  );
  const reviewGuideSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveReviewGuideModelSelection(
        settings,
        projectAgentProviders,
        target?.projectId ?? null,
      ),
    },
    projectAgentProviders,
  );
  const reviewGuideModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    projectAgentProviders,
    reviewGuideSelection.instanceId,
    reviewGuideSelection.model,
  );
  const canEnableReviewGuideModel = instanceEntries.some(
    (entry) =>
      entry.instanceId === reviewGuideSelection.instanceId && entry.enabled && entry.isAvailable,
  );
  const reviewGuideInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === reviewGuideSelection.instanceId,
  );

  return (
    <SettingsSection id="source-control-text-generation" title="Commits & pull requests">
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={writingStyleMixed}
        {...searchableSetting("source-control-writing-style")}
        description={MODE_OPTIONS[style.mode].description}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label="commit and pull request writing"
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    mode: defaults.mode,
                    customInstructions: defaults.customInstructions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={modeMixed ? null : style.mode}
            onValueChange={(value) => {
              const customInstructions = customInstructionsRef.current?.value.trim();
              updateSettings({
                sourceControlWritingStyle: {
                  mode: value as SourceControlWritingStyleMode,
                  ...(customInstructions !== undefined ? { customInstructions } : {}),
                },
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label="Commit and pull request writing"
            >
              <SelectValue>
                {(value: SourceControlWritingStyleMode | null) =>
                  value === null ? "Mixed" : MODE_OPTIONS[value].label
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {MODE_OPTIONS[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {writingStyleMixed ? (
          <div className="mt-3 max-w-2xl space-y-2 pb-3.5">
            {editingAllInstructions ? (
              <>
                <Textarea
                  value={allInstructions ?? ""}
                  onChange={(event) => setAllInstructions(event.target.value)}
                  rows={4}
                  aria-label="Custom commit and pull request instructions for all selected environments"
                  placeholder="Write the instructions each selected environment should use."
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={allInstructions === null}
                  onClick={() => {
                    if (allInstructions === null) return;
                    updateSettings({
                      sourceControlWritingStyle: {
                        mode: "custom",
                        customInstructions: allInstructions.trim(),
                      },
                    });
                    setEditingAllInstructions(false);
                  }}
                >
                  Apply instructions to all
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAllInstructions(null);
                  setEditingAllInstructions(true);
                }}
              >
                Write custom instructions for all
              </Button>
            )}
          </div>
        ) : style.mode === "custom" ? (
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={style.customInstructions}
              ref={customInstructionsRef}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions) {
                  updateSettings({ sourceControlWritingStyle: { customInstructions } });
                }
              }}
              rows={4}
              placeholder="Keep commit subjects under 60 characters. Keep pull request descriptions short and plain."
              aria-label="Custom commit and pull request instructions"
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["reviewGuidesEnabled"]}
        mixed={mixedReviewGuidesEnabled}
        {...searchableSetting("review-guides")}
        description={`Add a Guide tab to ${requestTerms.plural}. An agent explains the changes and points out decisions that need review.`}
        control={
          <Switch
            mixed={mixedReviewGuidesEnabled}
            checked={mixedReviewGuidesEnabled ? false : settings.reviewGuidesEnabled}
            onCheckedChange={(checked) => updateSettings({ reviewGuidesEnabled: Boolean(checked) })}
            aria-label="Review guides"
          />
        }
      />

      {settings.reviewGuidesEnabled || mixedReviewGuidesEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideModelSelection"]}
            {...searchableSetting("review-guide-model")}
            description={`Must be a coding agent: it reads the ${requestTerms.singular} over many steps. Off uses the writer model, or Codex or Claude if that model is a text generator.`}
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  Connect an environment to choose its review guide model.
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {(usesReviewGuideModel || mixedReviewGuideModel) && canEnableReviewGuideModel ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={reviewGuideSelection.instanceId}
                      model={reviewGuideSelection.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={reviewGuideModelOptionsByInstance}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel="Review guide model"
                      {...(mixedReviewGuideModel ? { triggerLabel: "Mixed" } : {})}
                      getModelDisabledReason={writerModelDisabledReason}
                      onInstanceModelChange={(instanceId, model) => {
                        const reason = writerModelDisabledReason(instanceId, model);
                        if (reason) {
                          toastManager.add({
                            type: "error",
                            title: "Review guide model not saved",
                            description: reason,
                          });
                          return;
                        }
                        updateSettings({
                          reviewGuideModelSelection: createModelSelection(instanceId, model),
                        });
                      }}
                    />
                  ) : null}
                  {usesReviewGuideModel &&
                  canEnableReviewGuideModel &&
                  !mixedReviewGuideModel &&
                  reviewGuideInstanceEntry ? (
                    <TraitsPicker
                      provider={reviewGuideInstanceEntry.driverKind}
                      models={reviewGuideInstanceEntry.models}
                      model={reviewGuideSelection.model}
                      modelOptions={reviewGuideSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      includePlanAgent={selectsPlanAgent(reviewGuideSelection.options)}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        updateSettings({
                          reviewGuideModelSelection: createModelSelection(
                            reviewGuideSelection.instanceId,
                            reviewGuideSelection.model,
                            options,
                          ),
                        })
                      }
                    />
                  ) : null}
                  <Switch
                    mixed={mixedReviewGuideModel}
                    checked={mixedReviewGuideModel ? false : usesReviewGuideModel}
                    disabled={!usesReviewGuideModel && !canEnableReviewGuideModel}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        updateSettings({ reviewGuideModelSelection: null });
                        return;
                      }
                      const seed = textGeneratorForSelection(settings, activeSelection.instanceId)
                        ? reviewGuideSelection
                        : activeSelection;
                      const reason = writerModelDisabledReason(seed.instanceId, seed.model);
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: "Review guide model not saved",
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        reviewGuideModelSelection: createModelSelection(
                          seed.instanceId,
                          seed.model,
                          seed.options,
                        ),
                      });
                    }}
                    aria-label="Use a separate review guide model"
                  />
                </div>
              )
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideInstructions"]}
            {...searchableSetting("review-guide-instructions")}
            description="Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same."
            resetAction={
              mixedReviewGuideInstructions || settings.reviewGuideInstructions !== "" ? (
                <SettingResetButton
                  label="review guide instructions"
                  onClick={() => updateSettings({ reviewGuideInstructions: "" })}
                />
              ) : null
            }
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={`${scopeKey}:${mixedReviewGuideInstructions}:${settings.reviewGuideInstructions}`}
                aria-label="Review guide instructions"
                onChange={() => {
                  reviewGuideInstructionsEdited.current = true;
                }}
                rows={4}
                defaultValue={mixedReviewGuideInstructions ? "" : settings.reviewGuideInstructions}
                placeholder={
                  mixedReviewGuideInstructions
                    ? "Mixed. Enter instructions to apply to all selected targets."
                    : "Show service interfaces before implementations. Skip test files unless they change behavior. Keep summaries to two sentences."
                }
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (
                    reviewGuideInstructionsEdited.current &&
                    (mixedReviewGuideInstructions || value !== settings.reviewGuideInstructions)
                  )
                    updateSettings({ reviewGuideInstructions: value });
                  reviewGuideInstructionsEdited.current = false;
                }}
              />
            </div>
          </SettingsRow>
        </>
      ) : null}
      <AdvancedSettings
        targetIds={[
          searchableSetting("follow-change-request-templates").id,
          searchableSetting("source-control-writer-model").id,
        ]}
      >
        <SettingsRow
          serverScoped
          settingKeys={["sourceControlWritingStyle"]}
          mixed={templatesMixed}
          {...searchableSetting("follow-change-request-templates")}
          description="Use the repository's pull request template when it has one."
          resetAction={
            templatesMixed ||
            style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
              <SettingResetButton
                label="pull request templates"
                onClick={() =>
                  updateSettings({
                    sourceControlWritingStyle: {
                      followChangeRequestTemplates: defaults.followChangeRequestTemplates,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              mixed={templatesMixed}
              checked={templatesMixed ? false : style.followChangeRequestTemplates}
              onCheckedChange={(checked) =>
                updateSettings({
                  sourceControlWritingStyle: {
                    followChangeRequestTemplates: Boolean(checked),
                  },
                })
              }
              aria-label="Follow pull request templates"
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["sourceControlWriterModelSelection"]}
          {...searchableSetting("source-control-writer-model")}
          description="Model for commit messages, pull request text, and branch or bookmark names. When disabled, use the text generation model configured for this environment."
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its source control writer model.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesDedicatedModel && !canEnableDedicatedModel ? (
                  <span className="text-sm text-muted-foreground">
                    No text generation providers available.
                  </span>
                ) : null}
                {usesDedicatedModel && canEnableDedicatedModel ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={activeSelection.instanceId}
                    model={activeSelection.model}
                    lockedProvider={null}
                    instanceEntries={writerEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Source control writer model"
                    {...(mixedWriterModel ? { triggerLabel: "Mixed" } : {})}
                    {...(environmentId
                      ? {
                          onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId, instanceId },
                            });
                          },
                        }
                      : {})}
                    getModelDisabledReason={writerModelDisabledReason}
                    onInstanceModelChange={(instanceId, model) => {
                      const reason = writerModelDisabledReason(instanceId, model);
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: "Source control writer model not saved",
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        sourceControlWriterModelSelection: createModelSelection(instanceId, model),
                      });
                    }}
                  />
                ) : null}
                {usesDedicatedModel &&
                canEnableDedicatedModel &&
                !mixedWriterModel &&
                writerInstanceEntry ? (
                  <TraitsPicker
                    provider={writerInstanceEntry.driverKind}
                    models={writerInstanceEntry.models}
                    model={activeSelection.model}
                    modelOptions={activeSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    includePlanAgent={selectsPlanAgent(activeSelection.options)}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      updateSettings({
                        sourceControlWriterModelSelection: createModelSelection(
                          activeSelection.instanceId,
                          activeSelection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
                <Switch
                  checked={usesDedicatedModel}
                  disabled={!usesDedicatedModel && !canEnableDedicatedModel}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sourceControlWriterModelSelection: checked
                        ? createModelSelection(
                            defaultModelSelection.instanceId,
                            defaultModelSelection.model,
                            defaultModelSelection.options,
                          )
                        : null,
                    })
                  }
                  aria-label="Use a separate source control writer model"
                />
              </div>
            )
          }
        />
      </AdvancedSettings>
    </SettingsSection>
  );
}

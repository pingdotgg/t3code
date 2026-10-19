import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type {
  ModelSelection,
  ProviderInstanceId,
  ServerSettings,
  SourceControlWritingStyleMode,
  UnifiedSettings,
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
import { useScopedModelDisabledReason, useScopedModelSettings } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
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
import { BranchNamingSettings } from "./BranchNamingSettings";
import { searchableSetting } from "./settingsSearch";

const MODE_OPTIONS: Record<SourceControlWritingStyleMode, { label: string; description: string }> =
  {
    repo_conventions: {
      label: "Repository conventions",
      description: "In each project, matches recent change descriptions and change request titles.",
    },
    conventional_commits: {
      label: "Conventional Commits",
      description: "Use Conventional Commit prefixes and keep change request text concise.",
    },
    custom: {
      label: "Custom instructions",
      description:
        "Use your instructions for change descriptions and change requests in every project.",
    },
  };

function useTextGenerationSettings(
  settings: UnifiedSettings,
  key: "sourceControlWriterModelSelection" | "reviewGuideModelSelection",
) {
  const model = useScopedModelSettings(settings, key);
  const providers = model.providers.filter((provider) => provider.supportsTextGeneration !== false);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      model.settings,
      model.target?.projectId ?? null,
    ),
  );
  const enabledIds = new Set(
    entries.filter((entry) => entry.enabled && entry.isAvailable).map((entry) => entry.instanceId),
  );
  return {
    ...model,
    entries,
    providers: providers.filter((provider) => enabledIds.has(provider.instanceId)),
  };
}

export function SourceControlWritingSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedReviewGuidesEnabled = useScopedSettingsMixed(["reviewGuidesEnabled"]);
  const navigate = useNavigate();
  const { connectedEnvironments, targets } = useSettingsScope();
  const hasServerTargets = connectedEnvironments.length > 0;
  const styleTargets = targets.filter(
    (target) => !target.unsupportedSettingKeys?.has("sourceControlWritingStyle"),
  );
  const styleFieldMixed = (field: keyof ServerSettings["sourceControlWritingStyle"]) => {
    const first = styleTargets[0];
    return (
      first !== undefined &&
      styleTargets.some(
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

  const writer = useTextGenerationSettings(settings, "sourceControlWriterModelSelection");
  const environmentId = writer.target?.environmentId ?? null;
  const instanceEntries = writer.entries;
  const defaultModelSelection = resolveAppModelSelectionState(writer.settings, writer.providers);
  const usesDedicatedModel = writer.settings.sourceControlWriterModelSelection !== null;
  const activeSelection = resolveAppModelSelectionState(
    {
      ...writer.settings,
      textGenerationModelSelection: resolveSourceControlWriterModelSelection(
        writer.settings,
        writer.providers,
        writer.target?.projectId ?? null,
      ),
    },
    writer.providers,
  );
  const canEnableDedicatedModel = instanceEntries.some(
    (entry) =>
      entry.instanceId === defaultModelSelection.instanceId && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    writer.settings,
    writer.providers,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const writerModelDisabledReason = useScopedModelDisabledReason(
    writer.settings,
    instanceEntries,
    "sourceControlWriterModelSelection",
  );
  const writerInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeSelection.instanceId,
  );
  const reviewGuide = useTextGenerationSettings(settings, "reviewGuideModelSelection");
  const reviewGuideEnvironmentId = reviewGuide.target?.environmentId ?? null;
  const usesReviewGuideModel = reviewGuide.settings.reviewGuideModelSelection !== null;
  const reviewGuideDefaultSelection = resolveAppModelSelectionState(
    {
      ...reviewGuide.settings,
      textGenerationModelSelection: resolveSourceControlWriterModelSelection(
        reviewGuide.settings,
        reviewGuide.providers,
        reviewGuide.target?.projectId ?? null,
      ),
    },
    reviewGuide.providers,
  );
  const reviewGuideSelection = resolveAppModelSelectionState(
    {
      ...reviewGuide.settings,
      textGenerationModelSelection: resolveReviewGuideModelSelection(
        reviewGuide.settings,
        reviewGuide.providers,
        reviewGuide.target?.projectId ?? null,
      ),
    },
    reviewGuide.providers,
  );
  const canEnableReviewGuideModel = reviewGuide.entries.some(
    (entry) =>
      entry.instanceId === reviewGuideDefaultSelection.instanceId &&
      entry.enabled &&
      entry.isAvailable,
  );
  const reviewGuideModelOptionsByInstance = getCustomModelOptionsByInstance(
    reviewGuide.settings,
    reviewGuide.providers,
    reviewGuideSelection.instanceId,
    reviewGuideSelection.model,
  );
  const reviewGuideModelDisabledReason = useScopedModelDisabledReason(
    reviewGuide.settings,
    reviewGuide.entries,
    "reviewGuideModelSelection",
  );
  const reviewGuideInstanceEntry = reviewGuide.entries.find(
    (entry) => entry.instanceId === reviewGuideSelection.instanceId,
  );
  const setWriterModel = (value: ModelSelection | null) => {
    const reason = value ? writerModelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({
        type: "error",
        title: "Source control writer model not saved",
        description: reason,
      });
      return;
    }
    updateSettings({ sourceControlWriterModelSelection: value });
  };
  const setReviewGuideModel = (value: ModelSelection | null) => {
    const reason = value ? reviewGuideModelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({
        type: "error",
        title: "Review guide model not saved",
        description: reason,
      });
      return;
    }
    updateSettings({ reviewGuideModelSelection: value });
  };

  return (
    <SettingsSection id="source-control-text-generation" title="Text generation">
      <BranchNamingSettings />
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={writingStyleMixed}
        {...searchableSetting("source-control-writing-style")}
        description={MODE_OPTIONS[style.mode].description}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label="source control writing style"
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
              aria-label="Source control writing style"
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
                  aria-label="Custom source control instructions for all selected environments"
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
              placeholder="Keep titles concise. Use short bullet points in descriptions."
              aria-label="Custom source control writing instructions"
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={templatesMixed}
        {...searchableSetting("follow-change-request-templates")}
        description="Use the repository's template for change request descriptions when available."
        resetAction={
          templatesMixed ||
          style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
            <SettingResetButton
              label="change request templates"
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
            aria-label="Follow change request templates"
          />
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWriterModelSelection"]}
        {...searchableSetting("source-control-writer-model")}
        description="Model for source control text and branch or bookmark names. Off uses the environment's text generation model."
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
                  instanceEntries={instanceEntries}
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
                  onInstanceModelChange={(instanceId, model) =>
                    setWriterModel(createModelSelection(instanceId, model))
                  }
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
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={activeSelection.options ?? []}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={
                    writer.settings.planModeEnabled || selectsPlanAgent(activeSelection.options)
                  }
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    setWriterModel(
                      createModelSelection(
                        activeSelection.instanceId,
                        activeSelection.model,
                        options,
                      ),
                    )
                  }
                />
              ) : null}
              <Switch
                checked={usesDedicatedModel}
                disabled={!usesDedicatedModel && !canEnableDedicatedModel}
                onCheckedChange={(checked) =>
                  setWriterModel(checked ? defaultModelSelection : null)
                }
                aria-label="Use a separate source control writer model"
              />
            </div>
          )
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["reviewGuidesEnabled"]}
        mixed={mixedReviewGuidesEnabled}
        {...searchableSetting("review-guides")}
        description="Adds a Guide tab to pull requests: an agent writes a tour of the change, stop by stop, with the calls a maintainer should make."
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
            description="Model that reads a pull request to write its review guide. It reads the change itself over many steps, so a stronger model helps. Off uses the source control writer model."
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  Connect an environment to choose its review guide model.
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {(usesReviewGuideModel || mixedReviewGuideModel) && canEnableReviewGuideModel ? (
                    <ProviderModelPicker
                      environmentId={reviewGuideEnvironmentId}
                      activeInstanceId={reviewGuideSelection.instanceId}
                      model={reviewGuideSelection.model}
                      lockedProvider={null}
                      instanceEntries={reviewGuide.entries}
                      modelOptionsByInstance={reviewGuideModelOptionsByInstance}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel="Review guide model"
                      {...(mixedReviewGuideModel ? { triggerLabel: "Mixed" } : {})}
                      getModelDisabledReason={reviewGuideModelDisabledReason}
                      {...(reviewGuideEnvironmentId
                        ? {
                            onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                              void navigate({
                                to: "/settings/providers",
                                search: { environmentId: reviewGuideEnvironmentId, instanceId },
                              });
                            },
                          }
                        : {})}
                      onInstanceModelChange={(instanceId, model) =>
                        setReviewGuideModel(createModelSelection(instanceId, model))
                      }
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
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={reviewGuideSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={
                        reviewGuide.settings.planModeEnabled ||
                        selectsPlanAgent(reviewGuideSelection.options)
                      }
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        setReviewGuideModel(
                          createModelSelection(
                            reviewGuideSelection.instanceId,
                            reviewGuideSelection.model,
                            options,
                          ),
                        )
                      }
                    />
                  ) : null}
                  <Switch
                    mixed={mixedReviewGuideModel}
                    checked={mixedReviewGuideModel ? false : usesReviewGuideModel}
                    disabled={!usesReviewGuideModel && !canEnableReviewGuideModel}
                    onCheckedChange={(checked) =>
                      setReviewGuideModel(checked ? reviewGuideDefaultSelection : null)
                    }
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
    </SettingsSection>
  );
}

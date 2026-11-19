import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  type ProviderInstanceId,
  type ServerSettings,
  type SourceControlWritingStyleMode,
  textGeneratorForSelection,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";
import { msg, T, useGT, useMessages } from "gt-react";

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
  getTextGenerationModelOptionsByInstance,
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
import { useSearchableSetting } from "./settingsSearch";

const MODE_OPTIONS: Record<SourceControlWritingStyleMode, { label: string; description: string }> =
  {
    repo_conventions: {
      label: msg("Repository conventions"),
      description: msg(
        "Commit messages and pull request titles and descriptions match each project's history.",
      ),
    },
    conventional_commits: {
      label: msg("Conventional Commits"),
      description: msg(
        "Conventional Commit prefixes, with short pull request titles and descriptions.",
      ),
    },
    custom: {
      label: msg("Custom instructions"),
      description: msg(
        "Your instructions shape commit messages and pull request titles and descriptions.",
      ),
    },
  };

export function SourceControlWritingSettingsSection() {
  const messages = useMessages();
  const setting = useSearchableSetting();
  const gt = useGT();
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
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    projectEffectiveTextGenerationProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const writerModelDisabledReason = useScopedModelDisabledReason(settings, writerEntries, true);
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
  const reviewGuideModelOptionsByInstance = getTextGenerationModelOptionsByInstance(
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
    <SettingsSection id="source-control-text-generation" title={gt("Commits & pull requests")}>
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={writingStyleMixed}
        {...setting("source-control-writing-style")}
        description={messages(MODE_OPTIONS[style.mode].description)}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              ariaLabel={gt("Reset commit and pull request writing to default")}
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
              aria-label={gt("Commit and pull request writing")}
            >
              <SelectValue>
                {(value: SourceControlWritingStyleMode | null) =>
                  value === null ? gt("Mixed") : messages(MODE_OPTIONS[value].label)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {messages(MODE_OPTIONS[mode].label)}
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
                  aria-label={gt(
                    "Custom commit and pull request instructions for all selected environments",
                  )}
                  placeholder={gt("Write the instructions each selected environment should use.")}
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
                  <T>Apply instructions to all</T>
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
                <T>Write custom instructions for all</T>
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
              placeholder={gt(
                "Keep commit subjects under 60 characters. Keep pull request descriptions short and plain.",
              )}
              aria-label={gt("Custom commit and pull request instructions")}
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["reviewGuidesEnabled"]}
        mixed={mixedReviewGuidesEnabled}
        {...setting("review-guides")}
        description={gt(
          "Add a Guide tab to pull requests. An agent explains the changes and points out decisions that need review.",
        )}
        control={
          <Switch
            mixed={mixedReviewGuidesEnabled}
            checked={mixedReviewGuidesEnabled ? false : settings.reviewGuidesEnabled}
            onCheckedChange={(checked) => updateSettings({ reviewGuidesEnabled: Boolean(checked) })}
            aria-label={gt("Review guides")}
          />
        }
      />

      {settings.reviewGuidesEnabled || mixedReviewGuidesEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideModelSelection"]}
            {...setting("review-guide-model")}
            description={gt(
              "Must be a coding agent: it reads the pull request over many steps. Off uses the writer model, or Codex or Claude if that model is a text generator.",
            )}
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  <T>Connect an environment to choose its review guide model.</T>
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
                      triggerAriaLabel={gt("Review guide model")}
                      {...(mixedReviewGuideModel ? { triggerLabel: gt("Mixed") } : {})}
                      getModelDisabledReason={writerModelDisabledReason}
                      onInstanceModelChange={(instanceId, model) => {
                        const reason = writerModelDisabledReason(instanceId, model);
                        if (reason) {
                          toastManager.add({
                            type: "error",
                            title: gt("Review guide model not saved"),
                            description: reason,
                          });
                          return;
                        }
                        updateSettings({
                          reviewGuideModelSelection: pickModelSelection(
                            mixedReviewGuideModel ? null : reviewGuideSelection,
                            instanceId,
                            model,
                          ),
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
                          title: gt("Review guide model not saved"),
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
                    aria-label={gt("Use a separate review guide model")}
                  />
                </div>
              )
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideInstructions"]}
            {...setting("review-guide-instructions")}
            description={gt(
              "Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same.",
            )}
            resetAction={
              mixedReviewGuideInstructions || settings.reviewGuideInstructions !== "" ? (
                <SettingResetButton
                  ariaLabel={gt("Reset review guide instructions to default")}
                  onClick={() => updateSettings({ reviewGuideInstructions: "" })}
                />
              ) : null
            }
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={`${scopeKey}:${mixedReviewGuideInstructions}:${settings.reviewGuideInstructions}`}
                aria-label={gt("Review guide instructions")}
                onChange={() => {
                  reviewGuideInstructionsEdited.current = true;
                }}
                rows={4}
                defaultValue={mixedReviewGuideInstructions ? "" : settings.reviewGuideInstructions}
                placeholder={
                  mixedReviewGuideInstructions
                    ? gt("Mixed. Enter instructions to apply to all selected targets.")
                    : gt(
                        "Show service interfaces before implementations. Skip test files unless they change behavior. Keep summaries to two sentences.",
                      )
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
          setting("follow-change-request-templates").id,
          setting("source-control-writer-model").id,
        ]}
      >
        <SettingsRow
          serverScoped
          settingKeys={["sourceControlWritingStyle"]}
          mixed={templatesMixed}
          {...setting("follow-change-request-templates")}
          description={gt("Use the repository's pull request template when it has one.")}
          resetAction={
            templatesMixed ||
            style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
              <SettingResetButton
                ariaLabel={gt("Reset pull request templates to default")}
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
              aria-label={gt("Follow pull request templates")}
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["sourceControlWriterModelSelection"]}
          {...setting("source-control-writer-model")}
          description={gt(
            "Model for commit messages, pull request text, and branch or bookmark names. When disabled, use the text generation model configured for this environment.",
          )}
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                <T>Connect an environment to choose its source control writer model.</T>
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesDedicatedModel && !canEnableDedicatedModel ? (
                  <span className="text-sm text-muted-foreground">
                    <T>No text generation providers available.</T>
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
                    triggerAriaLabel={gt("Source control writer model")}
                    {...(mixedWriterModel ? { triggerLabel: gt("Mixed") } : {})}
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
                          title: gt("Source control writer model not saved"),
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        sourceControlWriterModelSelection: pickModelSelection(
                          mixedWriterModel ? null : activeSelection,
                          instanceId,
                          model,
                        ),
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
                  onCheckedChange={(checked) => {
                    if (checked) {
                      const reason = writerModelDisabledReason(
                        defaultModelSelection.instanceId,
                        defaultModelSelection.model,
                      );
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: gt("Writer model not saved"),
                          description: reason,
                        });
                        return;
                      }
                    }
                    updateSettings({
                      sourceControlWriterModelSelection: checked
                        ? createModelSelection(
                            defaultModelSelection.instanceId,
                            defaultModelSelection.model,
                            defaultModelSelection.options,
                          )
                        : null,
                    });
                  }}
                  aria-label={gt("Use a separate source control writer model")}
                />
              </div>
            )
          }
        />
      </AdvancedSettings>
    </SettingsSection>
  );
}

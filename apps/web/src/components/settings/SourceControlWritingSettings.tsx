import { useNavigate } from "@tanstack/react-router";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { useT } from "../../hooks/useI18n";
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

const MODE_OPTIONS: Record<
  SourceControlWritingStyleMode,
  { label: MessageKey; description: MessageKey }
> = {
  repo_conventions: {
    label: "settings.code.scWriting.mode.repo.label",
    description: "settings.code.scWriting.mode.repo.description",
  },
  conventional_commits: {
    label: "settings.code.scWriting.mode.conventional.label",
    description: "settings.code.scWriting.mode.conventional.description",
  },
  custom: {
    label: "settings.code.scWriting.mode.custom.label",
    description: "settings.code.scWriting.mode.custom.description",
  },
};

export function SourceControlWritingSettingsSection() {
  const t = useT();
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
    <SettingsSection id="source-control-text-generation" title={t("settings.code.scWriting.title")}>
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={writingStyleMixed}
        {...searchableSetting("source-control-writing-style")}
        title={t("settings.code.scWriting.style.title")}
        description={t(MODE_OPTIONS[style.mode].description)}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label={t("settings.code.scWriting.style.resetLabel")}
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
              aria-label={t("settings.code.scWriting.style.title")}
            >
              <SelectValue>
                {(value: SourceControlWritingStyleMode | null) =>
                  value === null ? t("settings.layout.mixed") : t(MODE_OPTIONS[value].label)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {t(MODE_OPTIONS[mode].label)}
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
                  aria-label={t("settings.code.scWriting.allInstructionsAria")}
                  placeholder={t("settings.code.scWriting.allInstructionsPlaceholder")}
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
                  {t("settings.code.scWriting.applyToAll")}
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
                {t("settings.code.scWriting.writeForAll")}
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
              placeholder={t("settings.code.scWriting.customPlaceholder")}
              aria-label={t("settings.code.scWriting.customAria")}
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["reviewGuidesEnabled"]}
        mixed={mixedReviewGuidesEnabled}
        {...searchableSetting("review-guides")}
        title={t("settings.code.scWriting.guides.title")}
        description={t("settings.code.scWriting.guides.description")}
        control={
          <Switch
            mixed={mixedReviewGuidesEnabled}
            checked={mixedReviewGuidesEnabled ? false : settings.reviewGuidesEnabled}
            onCheckedChange={(checked) => updateSettings({ reviewGuidesEnabled: Boolean(checked) })}
            aria-label={t("settings.code.scWriting.guides.a11y")}
          />
        }
      />

      {settings.reviewGuidesEnabled || mixedReviewGuidesEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideModelSelection"]}
            {...searchableSetting("review-guide-model")}
            title={t("settings.code.scWriting.guideModel.title")}
            description={t("settings.code.scWriting.guideModel.description")}
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  {t("settings.code.scWriting.guideModel.connect")}
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
                      triggerAriaLabel={t("settings.code.scWriting.guideModel.title")}
                      {...(mixedReviewGuideModel
                        ? { triggerLabel: t("settings.layout.mixed") }
                        : {})}
                      getModelDisabledReason={writerModelDisabledReason}
                      onInstanceModelChange={(instanceId, model) => {
                        const reason = writerModelDisabledReason(instanceId, model);
                        if (reason) {
                          toastManager.add({
                            type: "error",
                            title: t("settings.code.scWriting.guideModel.notSaved"),
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
                          title: t("settings.code.scWriting.guideModel.notSaved"),
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
                    aria-label={t("settings.code.scWriting.guideModel.separate")}
                  />
                </div>
              )
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideInstructions"]}
            {...searchableSetting("review-guide-instructions")}
            title={t("settings.code.scWriting.guideInstructions.title")}
            description={t("settings.code.scWriting.guideInstructions.description")}
            resetAction={
              mixedReviewGuideInstructions || settings.reviewGuideInstructions !== "" ? (
                <SettingResetButton
                  label={t("settings.code.scWriting.guideInstructions.resetLabel")}
                  onClick={() => updateSettings({ reviewGuideInstructions: "" })}
                />
              ) : null
            }
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={`${scopeKey}:${mixedReviewGuideInstructions}:${settings.reviewGuideInstructions}`}
                aria-label={t("settings.code.scWriting.guideInstructions.title")}
                onChange={() => {
                  reviewGuideInstructionsEdited.current = true;
                }}
                rows={4}
                defaultValue={mixedReviewGuideInstructions ? "" : settings.reviewGuideInstructions}
                placeholder={
                  mixedReviewGuideInstructions
                    ? t("settings.code.scWriting.guideInstructions.placeholderMixed")
                    : t("settings.code.scWriting.guideInstructions.placeholder")
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
          title={t("settings.code.scWriting.templates.title")}
          description={t("settings.code.scWriting.templates.description")}
          resetAction={
            templatesMixed ||
            style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
              <SettingResetButton
                label={t("settings.code.scWriting.templates.resetLabel")}
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
              aria-label={t("settings.code.scWriting.templates.title")}
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["sourceControlWriterModelSelection"]}
          {...searchableSetting("source-control-writer-model")}
          title={t("settings.code.scWriting.writerModel.title")}
          description={t("settings.code.scWriting.writerModel.description")}
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                {t("settings.code.scWriting.writerModel.connect")}
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesDedicatedModel && !canEnableDedicatedModel ? (
                  <span className="text-sm text-muted-foreground">
                    {t("settings.code.scWriting.writerModel.noProviders")}
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
                    triggerAriaLabel={t("settings.code.scWriting.writerModel.title")}
                    {...(mixedWriterModel ? { triggerLabel: t("settings.layout.mixed") } : {})}
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
                          title: t("settings.code.scWriting.writerModel.notSaved"),
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
                  aria-label={t("settings.code.scWriting.writerModel.separate")}
                />
              </div>
            )
          }
        />
      </AdvancedSettings>
    </SettingsSection>
  );
}

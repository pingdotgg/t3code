import { useRef, useState } from "react";
import * as Equal from "effect/Equal";
import { createModelSelection } from "@t3tools/shared/model";
import { useEnvironmentProviders } from "../../state/environments";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import {
  dedupeProviderSkillsByName,
  isProviderSkillUserInvocable,
} from "@t3tools/client-runtime/providerSkills";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { reconcileSnoozeDraft } from "./SnoozePresetsSettings.logic";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { XIcon } from "lucide-react";
import { toastManager } from "../ui/toast";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { searchableSetting } from "./settingsSearch";
import { hasSideChatSettings } from "./sideChatSettingsSupport";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsRow,
  SettingsSection,
  SettingResetButton,
} from "./settingsLayout";

const DEFAULT_TEACHING_LINE =
  "Answer at their level, briefly and clearly, and stay on the highlighted topic; the lesson continues elsewhere.";
const normalizeSkillName = (name: string) => name.trim().replace(/^[\p{Sc}/]+/u, "");

export function SideChatSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const supportsSideChatSettings = hasSideChatSettings(settings);
  const providers = environment
    ? (providersByEnvironment.get(environment.environmentId) ?? [])
    : [];
  const pickerEntries = providerInstanceEntriesFor(providers, settings, null);
  const selection = supportsSideChatSettings ? settings.sideChatModelSelection : null;
  const active = selection
    ? pickerEntries.find((entry) => entry.instanceId === selection.instanceId)
    : undefined;
  const mixedModel = useScopedSettingsMixed(["sideChatModelSelection"]);
  const mixedInstructions = useScopedSettingsMixed(["sideChatInstructions"]);
  const mixedSkills = useScopedSettingsMixed(["sideChatSkills"]);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, pickerEntries);
  const seedSelection = resolveProjectDefaultProviderModelSelection(providers, settings, null);
  const [skillDraft, setSkillDraft] = useState("");
  const [draft, setDraft] = useState(supportsSideChatSettings ? settings.sideChatSkills : []);
  const [written, setWritten] = useState<ReadonlyArray<ReadonlyArray<string>>>([]);
  const [savedSource, setSavedSource] = useState<ReadonlyArray<string> | null>(
    supportsSideChatSettings ? settings.sideChatSkills : [],
  );
  const edited = useRef(false);
  const savedSkills = supportsSideChatSettings ? settings.sideChatSkills : [];
  if (!Equal.equals(savedSource, savedSkills)) {
    setSavedSource(savedSkills);
    const reconciled = reconcileSnoozeDraft(written, savedSkills);
    if (reconciled.adopt) {
      setWritten([]);
      setDraft(savedSkills);
    } else setWritten(reconciled.pending);
  }
  const saveSkills = (next: ReadonlyArray<string>) => {
    setDraft(next);
    setWritten((current) => [...current, next]);
    update(
      { sideChatSkills: next },
      {
        onFailed: () => {
          setWritten([]);
          setSavedSource(null);
        },
      },
    );
  };
  const skills = draft;
  const allSkills = pickerEntries.flatMap((entry) =>
    dedupeProviderSkillsByName(entry.snapshot.skills.filter(isProviderSkillUserInvocable)).map(
      (skill) => ({ ...skill, provider: entry.displayName, instanceId: entry.instanceId }),
    ),
  );
  const uniqueSkills = allSkills.filter((skill, index, list) => {
    const normalized = normalizeSkillName(skill.name).toLowerCase();
    return (
      list.findIndex(
        (candidate) =>
          candidate.name
            .trim()
            .replace(/^[\p{Sc}/]+/u, "")
            .toLowerCase() === normalized,
      ) === index
    );
  });
  if (!supportsSideChatSettings) return null;
  // `instanceId` keys rows; the typed entry below has no provider instance.
  const skillOptions = uniqueSkills.map(
    (skill): { name: string; provider: string; instanceId: string } => ({
      name: skill.name,
      provider: skill.provider,
      instanceId: skill.instanceId,
    }),
  );
  const skillQuery = normalizeSkillName(skillDraft);
  const skillQueryKey = skillQuery.toLowerCase();
  const addedSkills = new Set(skills.map((skill) => normalizeSkillName(skill).toLowerCase()));
  const exactSkill = skillOptions.find(
    (skill) => normalizeSkillName(skill.name).toLowerCase() === skillQueryKey,
  );
  const filteredSkillOptions = skillQuery
    ? [
        ...(exactSkill && !addedSkills.has(skillQueryKey) ? [exactSkill] : []),
        ...skillOptions.filter(
          (skill) =>
            skill !== exactSkill &&
            !addedSkills.has(normalizeSkillName(skill.name).toLowerCase()) &&
            normalizeSkillName(skill.name).toLowerCase().includes(skillQueryKey),
        ),
        ...(exactSkill === undefined && !addedSkills.has(skillQueryKey)
          ? [{ name: skillQuery, provider: "Add this name", instanceId: "typed" }]
          : []),
      ]
    : skillOptions.filter(
        (skill) => !addedSkills.has(normalizeSkillName(skill.name).toLowerCase()),
      );
  const addSkill = (name: string) => {
    const normalized = normalizeSkillName(name);
    const value = normalized;
    if (
      !value ||
      skills.some((skill) => normalizeSkillName(skill).toLowerCase() === value.toLowerCase()) ||
      skills.length >= 16
    )
      return;
    saveSkills([...skills, value]);
    setSkillDraft("");
  };
  return (
    <SettingsSection id="side-chats" title="Side chats">
      <SettingsRow
        serverScoped
        settingKeys={["sideChatModelSelection"]}
        mixed={mixedModel}
        {...searchableSetting("side-chat-model")}
        description="New side chats use the lesson's model unless you choose one here."
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {selection && active && !mixedModel ? (
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={pickerEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel="Side chat model"
                getModelDisabledReason={modelDisabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = modelDisabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Side chat model not saved",
                      description: reason,
                    });
                    return;
                  }
                  update({ sideChatModelSelection: createModelSelection(instanceId, model) });
                }}
              />
            ) : null}
            {selection && active && !mixedModel ? (
              <TraitsPicker
                provider={active.driverKind}
                models={active.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  update({
                    sideChatModelSelection: createModelSelection(
                      selection.instanceId,
                      selection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
            <span className="text-sm text-muted-foreground">Use the lesson's model</span>
            <Switch
              mixed={mixedModel}
              checked={mixedModel ? false : selection === null}
              disabled={!mixedModel && selection === null && seedSelection === null}
              onCheckedChange={(checked) =>
                (() => {
                  if (checked) {
                    update({ sideChatModelSelection: null });
                    return;
                  }
                  if (seedSelection === null) return;
                  const reason = modelDisabledReason(seedSelection.instanceId, seedSelection.model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Side chat model not saved",
                      description: reason,
                    });
                    return;
                  }
                  update({ sideChatModelSelection: seedSelection });
                })()
              }
              aria-label="Use the lesson's model"
            />
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["sideChatInstructions"]}
        mixed={mixedInstructions}
        {...searchableSetting("side-chat-instructions")}
        description="Replaces the default: answer at your level, briefly, and stay on the highlighted topic."
        resetAction={
          mixedInstructions || settings.sideChatInstructions ? (
            <SettingResetButton
              label="side chat instructions"
              onClick={() => update({ sideChatInstructions: "" })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            maxLength={2000}
            rows={4}
            aria-label="Side chat instructions"
            defaultValue={mixedInstructions ? "" : settings.sideChatInstructions}
            key={`${mixedInstructions}:${settings.sideChatInstructions}`}
            placeholder={
              mixedInstructions
                ? "Mixed. Enter instructions to apply to all selected targets."
                : DEFAULT_TEACHING_LINE
            }
            onChange={() => {
              edited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (edited.current && (mixedInstructions || value !== settings.sideChatInstructions))
                update({ sideChatInstructions: value });
              edited.current = false;
            }}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["sideChatSkills"]}
        mixed={mixedSkills}
        {...searchableSetting("side-chat-skills")}
        description="Skills are attached when a side chat starts, where its provider has them."
        resetAction={
          mixedSkills || skills.length > 0 ? (
            <SettingResetButton label="side chat skills" onClick={() => saveSkills([])} />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5 space-y-2">
          {skills.map((skill) => (
            <div key={skill} className="inline-flex items-center gap-1">
              <Badge variant="secondary">${skill}</Badge>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Remove ${skill}`}
                onClick={() => saveSkills(skills.filter((item) => item !== skill))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <Combobox<(typeof skillOptions)[number]>
            items={skillOptions}
            filteredItems={filteredSkillOptions}
            autoHighlight
            itemToStringLabel={(skill) => skill.name}
            value={null}
            onValueChange={(skill) => {
              if (skill) addSkill(skill.name);
            }}
            onOpenChange={(open) => {
              if (!open) setSkillDraft("");
            }}
          >
            <ComboboxTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={skills.length >= 16}
                  aria-label="Add a side chat skill"
                />
              }
            >
              Add skill
            </ComboboxTrigger>
            <ComboboxPopup align="start" className="w-80">
              <ComboboxSearchInput
                aria-label="Search or type a skill"
                placeholder="Search or type a skill"
                value={skillDraft}
                onChange={(event) => setSkillDraft(event.target.value)}
              />
              <ComboboxEmpty>No skills found.</ComboboxEmpty>
              <ComboboxList>
                {(skill: (typeof skillOptions)[number]) => (
                  <ComboboxItem
                    key={`${skill.instanceId}:${skill.name}`}
                    value={skill}
                    disabled={skills.length >= 16}
                  >
                    <span className="min-w-0 flex-1 truncate">${skill.name}</span>
                    <span className="text-xs text-muted-foreground">{skill.provider}</span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
          {skills.length >= 16 ? (
            <p className="text-xs text-muted-foreground">Up to 16 skills</p>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  PIPELINE_MAX_STEPS,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type PipelineDefinition,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useRef, useState } from "react";
import { Platform, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import {
  EnvironmentMachineSymbol,
  ENVIRONMENT_MACHINE_SYMBOLS,
} from "../../components/EnvironmentMachineSymbol";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { buildModelOptions } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  describePipelineSteps,
  draftToUpsertInput,
  moveStep,
  newStepDraft,
  normalizeSkillName,
  pipelineDraftIssues,
  pipelineToDraft,
  PIPELINE_STEP_SKILLS_MAX,
  resolveStepIds,
  type PipelineDraft,
  type PipelineStepDraft,
} from "@t3tools/client-runtime/pipeline-editor";
import { PIPELINE_STARTERS, type PipelineStarter } from "@t3tools/shared/pipelineStarters";
import { SettingsSection } from "./components/SettingsSection";
import {
  discardPipelineEditor,
  markPipelineEditorSaved,
  pipelineTargetSupportsPipelines,
  usePipelineEditor,
} from "./pipeline-editor";
import { FormField, PickerRow, SelectRow } from "./SettingsScheduledTasksRouteScreen";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

type PipelineRoutes = {
  SettingsPipelineNew: undefined;
  SettingsPipelineEdit: undefined;
  SettingsPipelineStepModel: undefined;
};

const BLANK_PIPELINE_ACTION = "blank";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Dialog.alert(title, String(squashAtomCommandFailure(result)));
  }
}

export function SettingsPipelinesRouteScreen() {
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const { startEditor, resetEditor, startFromStarter, pipelineTargets } = usePipelineEditor();
  const navigation = useNavigation<NativeStackNavigationProp<PipelineRoutes>>();
  const insets = useSafeAreaInsets();
  const newPipeline = (starter: PipelineStarter | null) => {
    if (pipelineTargets.length === 0) return;
    if (starter) startFromStarter(starter);
    else resetEditor();
    navigation.navigate("SettingsPipelineNew");
  };

  return (
    <>
      <SettingsEnvironmentFilterHeader
        trailingItems={[
          withNativeGlassHeaderItem({
            type: "menu",
            label: "",
            accessibilityLabel: "New pipeline",
            icon: { type: "sfSymbol", name: "plus" } as const,
            disabled: pipelineTargets.length === 0,
            menu: {
              title: "New pipeline",
              items: [
                {
                  type: "action" as const,
                  label: "Blank pipeline",
                  onPress: () => newPipeline(null),
                },
                ...PIPELINE_STARTERS.map((starter) => ({
                  type: "action" as const,
                  label: starter.name,
                  description: starter.description,
                  onPress: () => newPipeline(starter),
                })),
              ],
            },
          }),
        ]}
      />
      <SettingsScreen
        title="Pipelines"
        trailing={
          <View className="flex-row items-center">
            <AndroidSettingsEnvironmentFilter />
            <Menu
              title="New pipeline"
              actions={[
                { id: BLANK_PIPELINE_ACTION, title: "Blank pipeline" },
                ...PIPELINE_STARTERS.map((starter) => ({
                  id: starter.key,
                  title: starter.name,
                  subtitle: starter.description,
                })),
              ]}
              onPressAction={({ nativeEvent }) =>
                newPipeline(
                  PIPELINE_STARTERS.find((starter) => starter.key === nativeEvent.event) ?? null,
                )
              }
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New pipeline"
                accessibilityState={{ disabled: pipelineTargets.length === 0 }}
                disabled={pipelineTargets.length === 0}
                className="size-11 items-center justify-center rounded-full disabled:opacity-50"
              >
                <SymbolView name="plus" size={22} tintColorClassName="accent-icon" />
              </Pressable>
            </Menu>
          </View>
        }
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length > 0 ? (
            selectedTargets.map((environment) => (
              <EnvironmentPipelines
                key={environment.environmentId}
                environment={environment}
                onEdit={(pipeline) => {
                  startEditor({
                    environmentId: environment.environmentId,
                    environmentLabel: environment.label,
                    draft: pipelineToDraft(pipeline, uuidv4),
                    modelStepId: null,
                  });
                  navigation.navigate("SettingsPipelineEdit");
                }}
              />
            ))
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect an environment to view and create pipelines."
                : "No environments match these filters. Change the filter above."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

// The "New pipeline" action clears the editor before this screen opens, so it starts from the
// default target.
export function SettingsPipelineNewRouteScreen() {
  return <SettingsPipelineEditorScreen title="New pipeline" />;
}

export function SettingsPipelineEditRouteScreen() {
  return <SettingsPipelineEditorScreen title="Edit pipeline" />;
}

function SettingsPipelineEditorScreen({ title }: { readonly title: string }) {
  const { editor, setEditor, hasChanges, pipelineTargets, modelForEnvironment } =
    usePipelineEditor();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  // Set once the save lands, so the removal guard lets the editor close.
  const saved = useRef(false);
  const preventRemove = hasChanges || saving;
  usePreventRemove(preventRemove, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert("Saving pipeline", "Wait for the pipeline to finish saving before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => {
          discardPipelineEditor();
          navigation.dispatch(data.action);
        },
      },
    ]);
  });

  return (
    <SettingsScreen title={title}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            // Native Back pops before removal guards; a bar action lets the guard run first.
            unstable_headerLeftItems: () => [
              withNativeGlassHeaderItem({
                type: "button",
                label: "",
                accessibilityLabel: "Back",
                icon: { type: "sfSymbol", name: "chevron.backward" },
                onPress: () => navigation.goBack(),
              }),
            ],
          }}
        />
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {editor ? (
          <PipelineForm
            key={editor.environmentId}
            environmentId={editor.environmentId}
            environmentLabel={
              pipelineTargets.find((target) => target.environmentId === editor.environmentId)
                ?.label ?? editor.environmentLabel
            }
            targets={pipelineTargets}
            draft={editor.draft}
            saving={saving}
            setSaving={setSaving}
            setDraft={(draft) => {
              if (!saving) setEditor({ ...editor, draft });
            }}
            openModelPicker={(stepId) => setEditor({ ...editor, modelStepId: stepId })}
            onSaved={() => {
              saved.current = true;
              markPipelineEditorSaved();
              if (navigation.isFocused()) navigation.goBack();
            }}
            onChangeEnvironment={(target) => {
              if (target.environmentId === editor.environmentId) return;
              // Models belong to the environment, so every step takes the new one's default.
              const modelSelection = modelForEnvironment(target.environmentId);
              setEditor({
                environmentId: target.environmentId,
                environmentLabel: target.label,
                modelStepId: null,
                draft: {
                  ...editor.draft,
                  steps: editor.draft.steps.map((step) => ({ ...step, modelSelection })),
                },
              });
            }}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            Connect an environment that supports pipelines, or update its server, to create one.
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function PipelineForm({
  environmentId,
  environmentLabel,
  targets,
  draft,
  saving,
  setSaving,
  setDraft,
  openModelPicker,
  onSaved,
  onChangeEnvironment,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly targets: readonly SettingsTarget[];
  readonly draft: PipelineDraft;
  readonly saving: boolean;
  readonly setSaving: (saving: boolean) => void;
  readonly setDraft: (draft: PipelineDraft) => void;
  readonly openModelPicker: (stepId: string) => void;
  readonly onSaved: () => void;
  readonly onChangeEnvironment: (target: SettingsTarget) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<PipelineRoutes>>();
  const pipelines = useEnvironmentQuery(
    serverEnvironment.pipelinesLive({ environmentId, input: {} }),
  );
  const config = useEnvironmentServerConfig(environmentId);
  const canOperate = useAtomValue(serverEnvironment.upsertPipeline.permissionAtom(environmentId));
  const upsert = useAtomCommand(serverEnvironment.upsertPipeline, {
    label: "pipeline upsert",
    reportFailure: false,
  });
  const submissionPending = useRef(false);
  const pipelineMissing =
    draft.editingId !== null &&
    pipelines.data !== null &&
    !pipelines.data.pipelines.some((pipeline) => pipeline.id === draft.editingId);
  const environmentUnavailable = !targets.some((target) => target.environmentId === environmentId);
  const issues = pipelineDraftIssues(draft).messages;
  const stepIds = resolveStepIds(draft.steps);

  const updateStep = (stepId: string, patch: Partial<PipelineStepDraft>) =>
    setDraft({
      ...draft,
      steps: draft.steps.map((step) => (step.key === stepId ? { ...step, ...patch } : step)),
    });

  const save = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      pipelineMissing ||
      environmentUnavailable
    )
      return;
    const input = draftToUpsertInput(draft);
    if (!input) {
      Dialog.alert("Incomplete pipeline", issues[0] ?? "Fix the highlighted problems first.");
      return;
    }
    submissionPending.current = true;
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      reportFailure("Could not save pipeline", result);
      return;
    }
    onSaved();
  };

  return (
    <View className="gap-5">
      <View
        className="gap-5"
        pointerEvents={saving ? "none" : "auto"}
        accessibilityElementsHidden={saving}
        importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
      >
        {pipelineMissing ? (
          <Text className="px-1 text-base text-danger-foreground">
            This pipeline no longer exists.
          </Text>
        ) : null}
        {environmentUnavailable ? (
          <Text className="px-1 text-base text-danger-foreground">
            This environment is disconnected or does not support pipelines. Reconnect before saving.
          </Text>
        ) : null}
        <SettingsSection>
          <SelectRow
            label="Saved on"
            value={environmentLabel}
            valueIcon={
              <EnvironmentMachineSymbol
                kind={resolveEnvironmentMachineKind(config)}
                size={18}
                tintColorClassName="accent-foreground-muted"
              />
            }
            actions={
              draft.editingId || saving
                ? []
                : targets.map((target) => ({
                    id: target.environmentId,
                    title: target.label,
                    image:
                      ENVIRONMENT_MACHINE_SYMBOLS[
                        resolveEnvironmentMachineKind(target.serverConfig)
                      ],
                    state: target.environmentId === environmentId ? "on" : undefined,
                  }))
            }
            onSelect={(id) => {
              const target = targets.find((entry) => entry.environmentId === id);
              if (target) onChangeEnvironment(target);
            }}
          />
        </SettingsSection>
        <SettingsSection title="Pipeline">
          <FormField
            label="Name"
            disabled={saving}
            value={draft.name}
            placeholder="Plan, build, review"
            onChange={(name) => setDraft({ ...draft, name })}
          />
        </SettingsSection>

        {draft.steps.map((step, index) => (
          <StepSection
            key={step.key}
            stepId={stepIds[index]!}
            step={step}
            index={index}
            count={draft.steps.length}
            disabled={saving}
            modelLabel={modelLabel(
              buildModelOptions(config, step.modelSelection, undefined, null),
              step,
            )}
            onChange={(patch) => updateStep(step.key, patch)}
            onPickModel={() => {
              openModelPicker(step.key);
              navigation.navigate("SettingsPipelineStepModel");
            }}
            onMove={(delta) => setDraft({ ...draft, steps: moveStep(draft.steps, index, delta) })}
            onRemove={() =>
              setDraft({ ...draft, steps: draft.steps.filter((entry) => entry.key !== step.key) })
            }
          />
        ))}

        <Button
          label={
            draft.steps.length >= PIPELINE_MAX_STEPS
              ? `Up to ${PIPELINE_MAX_STEPS} steps`
              : "Add step"
          }
          icon="plus"
          disabled={saving || draft.steps.length >= PIPELINE_MAX_STEPS}
          onPress={() =>
            setDraft({
              ...draft,
              steps: [
                ...draft.steps,
                newStepDraft(
                  draft.steps,
                  { modelSelection: null, runtimeMode: "full-access" },
                  uuidv4,
                ),
              ],
            })
          }
        />

        {issues.length > 0 ? (
          <View className="gap-1 px-2">
            {issues.slice(0, 4).map((issue) => (
              <Text key={issue} className="text-sm text-danger-foreground">
                {issue}
              </Text>
            ))}
          </View>
        ) : null}
        <Text className="px-2 text-sm text-foreground-muted">
          All steps run in the same workspace, one after another. Each prompt template can use{" "}
          {"{{input}}"} (the text you start the pipeline with), {"{{previous.output}}"} and{" "}
          {"{{steps.<id>.output}}"}.
        </Text>
      </View>
      <Button
        tone="primary"
        fullWidth
        loading={saving}
        disabled={!canOperate || pipelineMissing || environmentUnavailable || issues.length > 0}
        onPress={() => void save()}
        label={saving ? "Saving…" : draft.editingId ? "Save changes" : "Create pipeline"}
      />
    </View>
  );
}

function modelLabel(
  options: ReturnType<typeof buildModelOptions>,
  step: PipelineStepDraft,
): string {
  const selection = step.modelSelection;
  if (!selection) return options.length ? "Choose model" : "No models available";
  return (
    options.find(
      (option) =>
        option.selection.instanceId === selection.instanceId &&
        option.selection.model === selection.model,
    )?.label ?? selection.model
  );
}

function IconAction(props: {
  readonly label: string;
  readonly name: "chevron.up" | "chevron.down" | "trash";
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="size-9 items-center justify-center active:opacity-70 disabled:opacity-30"
    >
      <SymbolView
        name={props.name}
        size={16}
        tintColorClassName={props.danger ? "accent-danger-foreground" : "accent-icon"}
      />
    </Pressable>
  );
}

function StepSection(props: {
  readonly step: PipelineStepDraft;
  /** The id the step is saved under. */
  readonly stepId: string;
  readonly index: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly modelLabel: string;
  readonly onChange: (patch: Partial<PipelineStepDraft>) => void;
  readonly onPickModel: () => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { step, index } = props;
  const [skillInput, setSkillInput] = useState("");
  const skillName = normalizeSkillName(skillInput);
  const addSkill = () => {
    if (!skillName) return;
    if (!step.skills.includes(skillName) && step.skills.length < PIPELINE_STEP_SKILLS_MAX) {
      props.onChange({ skills: [...step.skills, skillName] });
    }
    setSkillInput("");
  };
  const runtimeLabel =
    RUNTIME_MODE_CHOICES.find((choice) => choice.mode === step.runtimeMode)?.label ??
    step.runtimeMode;

  return (
    <SettingsSection
      title={`Step ${index + 1}`}
      trailing={
        <View className="flex-row items-center pr-2">
          <IconAction
            label={`Move step ${index + 1} up`}
            name="chevron.up"
            disabled={props.disabled || index === 0}
            onPress={() => props.onMove(-1)}
          />
          <IconAction
            label={`Move step ${index + 1} down`}
            name="chevron.down"
            disabled={props.disabled || index === props.count - 1}
            onPress={() => props.onMove(1)}
          />
          <IconAction
            label={`Remove step ${index + 1}`}
            name="trash"
            danger
            disabled={props.disabled || props.count <= 1}
            onPress={props.onRemove}
          />
        </View>
      }
    >
      <FormField
        label="Step name"
        disabled={props.disabled}
        value={step.name}
        onChange={(name) => props.onChange({ name })}
      />
      <PickerRow
        label="Model"
        borderTop
        value={props.modelLabel}
        disabled={props.disabled}
        onPress={props.onPickModel}
      />
      <SelectRow
        label="Permissions"
        borderTop
        value={runtimeLabel}
        actions={RUNTIME_MODE_CHOICES.map((choice) => ({
          id: choice.mode,
          title: choice.label,
          state: choice.mode === step.runtimeMode ? ("on" as const) : undefined,
        }))}
        onSelect={(id) => {
          const choice = RUNTIME_MODE_CHOICES.find((entry) => entry.mode === id);
          if (choice) props.onChange({ runtimeMode: choice.mode });
        }}
      />
      <View className="gap-2 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Skills</Text>
        {step.skills.length > 0 ? (
          <View className="flex-row flex-wrap gap-2">
            {step.skills.map((skill) => (
              <Pressable
                key={skill}
                accessibilityRole="button"
                accessibilityLabel={`Remove skill ${skill}`}
                disabled={props.disabled}
                onPress={() => props.onChange({ skills: step.skills.filter((s) => s !== skill) })}
                className="flex-row items-center gap-1 rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
              >
                <Text className="text-sm text-foreground">{skill}</Text>
                <SymbolView name="xmark" size={10} tintColorClassName="accent-foreground-muted" />
              </Pressable>
            ))}
          </View>
        ) : null}
        {step.skills.length < PIPELINE_STEP_SKILLS_MAX ? (
          <RNTextInput
            accessibilityLabel="Add skill"
            value={skillInput}
            readOnly={props.disabled}
            onChangeText={setSkillInput}
            onSubmitEditing={addSkill}
            onBlur={addSkill}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            placeholder="Add a skill name"
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-8 font-sans text-base text-foreground"
          />
        ) : null}
      </View>
      <View className="gap-2 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Prompt template</Text>
        <RNTextInput
          accessibilityLabel={`Prompt template for step ${index + 1}`}
          value={step.promptTemplate}
          readOnly={props.disabled}
          onChangeText={(promptTemplate) => props.onChange({ promptTemplate })}
          multiline
          scrollEnabled
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
          placeholder={index === 0 ? "{{input}}" : "{{previous.output}}"}
          placeholderTextColorClassName="accent-foreground-muted"
          className="max-h-48 min-h-24 font-sans text-base text-foreground"
        />
        <Text className="text-sm text-foreground-muted">
          {index === 0
            ? "Variables: {{input}}, {{steps.<id>.output}}. This step's id is "
            : "Variables: {{input}}, {{previous.output}}, {{steps.<id>.output}}. This step's id is "}
          {props.stepId}.
        </Text>
      </View>
      <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
        <Text textRole="body" className="min-w-0 flex-1 text-foreground">
          Pause before this step
        </Text>
        <ThemedSwitch
          accessibilityLabel={`Pause before step ${index + 1}`}
          value={step.pauseBefore}
          onValueChange={(pauseBefore) => props.onChange({ pauseBefore })}
        />
      </View>
    </SettingsSection>
  );
}

function EnvironmentPipelines({
  environment,
  onEdit,
}: {
  readonly environment: SettingsTarget;
  readonly onEdit: (pipeline: PipelineDefinition) => void;
}) {
  const environmentId = environment.environmentId;
  const supported = pipelineTargetSupportsPipelines(environment);
  const pipelines = useEnvironmentQuery(
    supported ? serverEnvironment.pipelinesLive({ environmentId, input: {} }) : null,
  );
  const canOperate = useAtomValue(serverEnvironment.upsertPipeline.permissionAtom(environmentId));
  const remove = useAtomCommand(serverEnvironment.deletePipeline, {
    label: "pipeline delete",
    reportFailure: false,
  });

  const confirmDelete = (pipeline: PipelineDefinition) =>
    Dialog.alert("Delete pipeline?", pipeline.name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
          void remove({ environmentId, input: { id: pipeline.id } }).then((result) =>
            reportFailure("Could not delete pipeline", result),
          );
        },
      },
    ]);

  return (
    <SettingsSection
      title={environment.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
      }
    >
      {!supported ? (
        <Text className="p-4 text-base text-foreground-muted">
          This server doesn't support pipelines yet. Update it to use them.
        </Text>
      ) : pipelines.error ? (
        <Text className="p-4 text-base text-danger-foreground">{pipelines.error}</Text>
      ) : !pipelines.data ? (
        <Text className="p-4 text-base text-foreground-muted">Loading pipelines…</Text>
      ) : pipelines.data.pipelines.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">No pipelines yet.</Text>
      ) : (
        pipelines.data.pipelines.map((pipeline, index) => (
          <View
            key={pipeline.id}
            className={
              index === 0
                ? "flex-row items-start gap-1 px-4 py-3"
                : "flex-row items-start gap-1 border-t border-border-subtle px-4 py-3"
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${pipeline.name}`}
              onPress={() => onEdit(pipeline)}
              className="min-w-0 flex-1 gap-1 active:opacity-70"
            >
              <Text textRole="body" className="text-foreground" numberOfLines={1}>
                {pipeline.name}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {describePipelineSteps(pipeline.steps)}
              </Text>
            </Pressable>
            <Menu
              actions={[
                { id: "edit", title: "Edit" },
                {
                  id: "delete",
                  title: "Delete",
                  attributes: { destructive: true, disabled: !canOperate },
                },
              ]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "edit") onEdit(pipeline);
                else if (nativeEvent.event === "delete") confirmDelete(pipeline);
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Actions for ${pipeline.name}`}
                className="h-11 w-11 items-center justify-center"
              >
                <SymbolView
                  name="ellipsis"
                  size={18}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </Pressable>
            </Menu>
          </View>
        ))
      )}
    </SettingsSection>
  );
}

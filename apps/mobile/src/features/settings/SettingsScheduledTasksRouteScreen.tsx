import type {
  EnvironmentId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFocusEffect, useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Alert, AppState, Platform, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import {
  EnvironmentMachineSymbol,
  ENVIRONMENT_MACHINE_SYMBOLS,
} from "../../components/EnvironmentMachineSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { buildModelOptions } from "../../lib/modelOptions";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { resolveNewTaskBranchLabel } from "../threads/new-task-context-presentation";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { ScheduledTaskPromptField } from "./components/ScheduledTaskPromptField";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import {
  buildScheduledTaskUpdateInput,
  editDraft,
  scheduledTaskDefaultModel,
  scheduleFromDraft,
  type ScheduledTaskDraft as Draft,
} from "./scheduledTaskDraft";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";
import { useScheduledTaskEditor } from "./scheduled-task-editor";
import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

type ScheduledTaskRoutes = {
  SettingsScheduledTaskNew: undefined;
  SettingsScheduledTaskEdit: undefined;
  SettingsScheduledTaskModel: undefined;
  SettingsScheduledTaskBranch: undefined;
};

const DAYS = [
  { index: 1, label: "Mon" },
  { index: 2, label: "Tue" },
  { index: 3, label: "Wed" },
  { index: 4, label: "Thu" },
  { index: 5, label: "Fri" },
  { index: 6, label: "Sat" },
  { index: 0, label: "Sun" },
] as const;

function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.type === "interval") return formatScheduledTaskInterval(task.schedule.everyMs);
  const days = task.schedule.weekdays?.length ? repeatLabel(task.schedule.weekdays) : "Every day";
  return `${days} at ${formatTime(task.schedule.timeOfDay)}`;
}

function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function timePickerValue(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);
  const time = new Date();
  time.setHours(
    Number.isInteger(hours) ? (hours ?? 9) : 9,
    Number.isInteger(minutes) ? (minutes ?? 0) : 0,
    0,
    0,
  );
  return time;
}

function repeatLabel(weekdays: ReadonlyArray<number>): string {
  const days = new Set(weekdays);
  if (days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => day.label)
      .join(", ") || "Choose days"
  );
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly keyboardType?: "decimal-pad";
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly borderTop?: boolean;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <RNTextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        textAlignVertical="center"
        keyboardType={props.keyboardType}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly valueIcon?: ReactNode;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
  const value = (
    <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
      {props.valueIcon}
      <Text className="shrink text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  );
  if (props.actions.length === 0) {
    return (
      <View
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
      </View>
    );
  }
  return (
    <ControlPillMenu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        }
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </ControlPillMenu>
  );
}

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.value}`}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text className="text-lg text-foreground">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SettingsScheduledTasksRouteScreen() {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const updateNow = () => setNow(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") updateNow();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, []),
  );
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const visibleEnvironments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const { startEditor, resetEditor } = useScheduledTaskEditor();
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const insets = useSafeAreaInsets();
  const newTask = () => {
    if (visibleEnvironments.length === 0) return;
    resetEditor();
    navigation.navigate("SettingsScheduledTaskNew");
  };

  return (
    <>
      <SettingsEnvironmentFilterHeader
        trailingItems={[
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: "New task",
            icon: { type: "sfSymbol", name: "plus" } as const,
            disabled: visibleEnvironments.length === 0,
            onPress: newTask,
          }),
        ]}
      />
      <SettingsScreen
        title="Scheduled Tasks"
        trailing={
          <View className="flex-row items-center">
            <AndroidSettingsEnvironmentFilter />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New task"
              accessibilityState={{ disabled: visibleEnvironments.length === 0 }}
              disabled={visibleEnvironments.length === 0}
              onPress={newTask}
              className="size-11 items-center justify-center rounded-full disabled:opacity-50"
            >
              <SymbolView name="plus" size={22} tintColorClassName="accent-icon" />
            </Pressable>
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
          {visibleEnvironments.length > 0 ? (
            visibleEnvironments.map((environment) => (
              <EnvironmentTasks
                key={environment.environmentId}
                environment={environment}
                now={now}
                projectIds={
                  selectedProjectKey === null
                    ? null
                    : (selectedGroup?.members
                        .filter(
                          (member) => member.project.environmentId === environment.environmentId,
                        )
                        .map((member) => member.project.id) ?? [])
                }
                onEdit={(task) => {
                  startEditor({
                    environmentId: environment.environmentId,
                    environmentLabel: environment.label,
                    draft: editDraft(task),
                  });
                  navigation.navigate("SettingsScheduledTaskEdit");
                }}
              />
            ))
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect an environment to view and create scheduled tasks."
                : "No environments match these filters. Change the filter above."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

export function SettingsScheduledTaskNewRouteScreen() {
  const { resetEditor } = useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (initialized.current || availableTargets.length === 0) return;
    initialized.current = true;
    resetEditor();
  }, [availableTargets.length, resetEditor]);
  return <SettingsScheduledTaskEditorScreen title="New scheduled task" />;
}

export function SettingsScheduledTaskEditRouteScreen() {
  return <SettingsScheduledTaskEditorScreen title="Edit scheduled task" />;
}

function SettingsScheduledTaskEditorScreen({ title }: { readonly title: string }) {
  const { editor, setEditor, hasChanges, draftForEnvironment } = useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const voiceOwnerId = useId();
  const ownerKey = editor ? `${voiceOwnerId}:${editor.environmentId}` : null;
  const prompt = editor?.draft.prompt ?? "";
  const [selectionState, setSelectionState] = useState<{
    readonly ownerKey: string | null;
    readonly selection: ComposerEditorSelection;
  } | null>(null);
  const selection =
    selectionState?.ownerKey === ownerKey
      ? selectionState.selection
      : { start: prompt.length, end: prompt.length };
  const setSelection = (next: ComposerEditorSelection) =>
    setSelectionState({ ownerKey, selection: next });
  const setPrompt = (next: string) =>
    setEditor((current) =>
      current
        ? {
            ...current,
            draft: { ...current.draft, prompt: next },
          }
        : current,
    );
  const voiceInput = useVoiceInputController({
    ownerKey,
    draftMessage: prompt,
    selection,
    onChangeSelection: setSelection,
    onChangeDraftMessage: setPrompt,
    disabled: saving,
  });
  const preventRemove = !saved && (hasChanges || saving || voiceInput.isBusy);
  usePreventRemove(preventRemove, ({ data }) => {
    if (saving) {
      Alert.alert("Saving task", "Wait for the task to finish saving before leaving.");
      return;
    }
    Alert.alert(
      "Discard changes?",
      voiceInput.isBusy
        ? "Your dictation and unsaved changes will be lost."
        : "Your unsaved changes will be lost.",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard changes",
          style: "destructive",
          onPress: () => navigation.dispatch(data.action),
        },
      ],
    );
  });
  useEffect(() => {
    if (!saved) return;
    // Let the native removal guard turn off before popping the saved form.
    const frame = requestAnimationFrame(() => {
      if (navigation.isFocused()) navigation.goBack();
    });
    return () => cancelAnimationFrame(frame);
  }, [navigation, saved]);
  return (
    <SettingsScreen title={title}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            // The system back button begins its native pop before the removal
            // guard runs. Dispatch from a bar action so the guard runs first.
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
          <TaskForm
            key={editor.environmentId}
            environmentId={editor.environmentId}
            environmentLabel={
              availableTargets.find((target) => target.environmentId === editor.environmentId)
                ?.label ?? editor.environmentLabel
            }
            availableTargets={availableTargets}
            draft={editor.draft}
            saving={saving}
            setSaving={setSaving}
            dictationPending={voiceInput.blocksSubmission}
            promptField={
              <ScheduledTaskPromptField
                value={prompt}
                onChange={setPrompt}
                selection={selection}
                onChangeSelection={setSelection}
                disabled={saving}
                voiceInput={voiceInput}
              />
            }
            setDraft={(draft) => {
              if (!saving) setEditor({ ...editor, draft });
            }}
            onSaved={() => setSaved(true)}
            onChangeEnvironment={(target) => {
              if (target.environmentId === editor.environmentId) return;
              setEditor({
                environmentId: target.environmentId,
                environmentLabel: target.label,
                draft: {
                  ...draftForEnvironment(target.environmentId),
                  title: editor.draft.title,
                  prompt: editor.draft.prompt,
                  schedule: editor.draft.schedule,
                  enabled: editor.draft.enabled,
                },
              });
            }}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Connect an environment to create a scheduled task."
              : "No environments match the current filters. Change the filters to create a task."}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function TaskForm({
  environmentId,
  environmentLabel,
  availableTargets,
  draft,
  saving,
  setSaving,
  dictationPending,
  promptField,
  setDraft,
  onSaved,
  onChangeEnvironment,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly availableTargets: readonly SettingsTarget[];
  readonly draft: Draft;
  readonly saving: boolean;
  readonly setSaving: (saving: boolean) => void;
  readonly dictationPending: boolean;
  readonly promptField: ReactNode;
  readonly setDraft: (draft: Draft) => void;
  readonly onSaved: () => void;
  readonly onChangeEnvironment: (target: SettingsTarget) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const config = useEnvironmentServerConfig(environmentId);
  const modelOptions = useMemo(() => buildModelOptions(config, null), [config]);
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
    reportFailure: false,
  });
  const update = useAtomCommand(serverEnvironment.updateScheduledTask, {
    label: "scheduled task update",
    reportFailure: false,
  });
  const submissionPending = useRef(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const taskMissing =
    draft.task !== null &&
    tasks.data !== null &&
    !tasks.data.tasks.some((task) => task.id === draft.task?.id);
  const environmentUnavailable = !availableTargets.some(
    (target) => target.environmentId === environmentId,
  );

  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Alert.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const save = async () => {
    if (
      submissionPending.current ||
      saving ||
      dictationPending ||
      taskMissing ||
      environmentUnavailable
    )
      return;
    const schedule = scheduleFromDraft(draft.schedule);
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !draft.projectId ||
      !draft.modelSelection ||
      !schedule ||
      (draft.workspace === "existing_worktree" && !draft.checkoutPath.trim())
    ) {
      Alert.alert(
        "Incomplete task",
        "Add a name, prompt, project, model, valid schedule, and checkout path if needed.",
      );
      return;
    }
    if (!projects.some((project) => project.id === draft.projectId)) {
      Alert.alert("Project unavailable", "Choose a project in this environment.");
      return;
    }
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    let result: AtomCommandResult<unknown, unknown> | null;
    if (draft.task !== null) {
      // Existing tasks save as a dirty-field patch through the atomic update
      // path: a stale editor can never overwrite fields another client
      // changed, and a delete racing the save is a typed not-found, not a
      // resurrection. `taskMissing` already guarantees the task is in the
      // live list.
      const liveTask = tasks.data?.tasks.find((task) => task.id === draft.task?.id);
      if (liveTask === undefined) {
        // The live list has not returned (or the task vanished between render
        // and save) — fail loudly instead of silently discarding the edit.
        setSaving(false);
        submissionPending.current = false;
        Alert.alert(
          "Task unavailable",
          "The task could not be loaded. Reopen it once the list has loaded and try again.",
        );
        return;
      }
      const patch = buildScheduledTaskUpdateInput(draft, liveTask);
      result = patch === null ? null : await update({ environmentId, input: patch });
    } else {
      const input: ScheduledTaskUpsertInput = {
        title: draft.title.trim(),
        prompt: draft.prompt.trim(),
        projectId: draft.projectId,
        modelSelection: draft.modelSelection,
        schedule,
        enabled: draft.enabled,
        threadId: null,
        workspaceStrategy:
          draft.workspace === "root"
            ? { type: "root" }
            : draft.workspace === "existing_worktree"
              ? { type: "existing_worktree", worktreePath: draft.checkoutPath.trim() }
              : {
                  type: "worktree",
                  baseRef: draft.baseRef.trim() || "main",
                  startFromOrigin: draft.startFromOrigin,
                },
        runtimeMode: draft.runtimeMode,
        interactionMode: "default",
        creationSource: "mobile",
      };
      result = await upsert({ environmentId, input });
    }
    setSaving(false);
    if (result !== null && result._tag === "Failure") {
      submissionPending.current = false;
      failure("Could not save task", result);
      return;
    }
    onSaved();
  };

  return (
    <View
      className="gap-5"
      pointerEvents={saving ? "none" : "auto"}
      accessibilityElementsHidden={saving}
      importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
    >
      {taskMissing ? (
        <Text className="px-1 text-base text-danger-foreground">This task no longer exists.</Text>
      ) : null}

      {environmentUnavailable ? (
        <Text className="px-1 text-base text-danger-foreground">
          This environment is disconnected. Reconnect before saving.
        </Text>
      ) : null}
      <SettingsSection>
        <SelectRow
          label="Runs on"
          value={environmentLabel}
          valueIcon={
            <EnvironmentMachineSymbol
              kind={resolveEnvironmentMachineKind(config)}
              size={18}
              tintColorClassName="accent-foreground-muted"
            />
          }
          actions={
            draft.task || saving || dictationPending
              ? []
              : availableTargets.map((target) => ({
                  id: target.environmentId,
                  title: target.label,
                  image:
                    ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(target.serverConfig)],
                  state: target.environmentId === environmentId ? "on" : undefined,
                }))
          }
          onSelect={(id) => {
            const target = availableTargets.find((entry) => entry.environmentId === id);
            if (target) onChangeEnvironment(target);
          }}
        />
      </SettingsSection>
      <SettingsSection title="Task">
        <FormField
          label="Name"
          disabled={saving}
          value={draft.title}
          placeholder="Check for issues"
          onChange={(title) => setDraft({ ...draft, title })}
        />
        {promptField}
      </SettingsSection>

      <SettingsSection title="Context">
        <SelectRow
          label="Project"
          value={
            projects.find((project) => project.id === draft.projectId)?.title ??
            (projects.length ? "Choose project" : "No projects available")
          }
          actions={projects.map((project) => ({
            id: project.id,
            title: project.title,
            state: project.id === draft.projectId ? "on" : undefined,
          }))}
          onSelect={(id) => {
            const project = projects.find((item) => item.id === id);
            if (project)
              setDraft({
                ...draft,
                projectId: project.id,
                modelSelection: draft.modelSelectionIsExplicit
                  ? draft.modelSelection
                  : scheduledTaskDefaultModel(config, project),
              });
          }}
        />
        <PickerRow
          label="Model"
          borderTop
          value={
            modelOptions.find(
              (option) =>
                option.selection.instanceId === draft.modelSelection?.instanceId &&
                option.selection.model === draft.modelSelection?.model,
            )?.label ??
            draft.modelSelection?.model ??
            (modelOptions.length ? "Choose model" : "No models available")
          }
          onPress={() => navigation.navigate("SettingsScheduledTaskModel")}
          disabled={saving || dictationPending || environmentUnavailable}
        />
      </SettingsSection>

      <SettingsSection title="Workspace">
        <SelectRow
          label="Run in"
          value={
            draft.workspace === "worktree"
              ? "New worktree"
              : draft.workspace === "root"
                ? "Project checkout"
                : "Specific checkout"
          }
          actions={[
            {
              id: "worktree",
              title: "New worktree",
              state: draft.workspace === "worktree" ? "on" : undefined,
            },
            {
              id: "root",
              title: "Project checkout",
              state: draft.workspace === "root" ? "on" : undefined,
            },
            {
              id: "existing_worktree",
              title: "Specific checkout",
              state: draft.workspace === "existing_worktree" ? "on" : undefined,
            },
          ]}
          onSelect={(id) => {
            if (id === "worktree" || id === "root" || id === "existing_worktree")
              setDraft({ ...draft, workspace: id });
          }}
        />
        {draft.workspace === "worktree" ? (
          <PickerRow
            label="Base branch"
            value={resolveNewTaskBranchLabel({
              branchName: draft.baseRef,
              startFromOrigin: draft.startFromOrigin,
              workspaceMode: "worktree",
            })}
            borderTop
            disabled={!draft.projectId || saving || dictationPending || environmentUnavailable}
            onPress={() => navigation.navigate("SettingsScheduledTaskBranch")}
          />
        ) : null}
        {draft.workspace === "existing_worktree" ? (
          <FormField
            label="Checkout path"
            disabled={saving}
            value={draft.checkoutPath}
            borderTop
            onChange={(checkoutPath) => setDraft({ ...draft, checkoutPath })}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Schedule">
        <View className="px-4 py-3">
          <SegmentedControl
            options={[
              { value: "fixed_time", label: "At a time" },
              { value: "interval", label: "Every interval" },
            ]}
            selected={draft.schedule.mode}
            onSelect={(mode) => {
              setTimePickerOpen(false);
              setDraft({ ...draft, schedule: { ...draft.schedule, mode } });
            }}
          />
        </View>
        {draft.schedule.mode === "fixed_time" ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Time, ${formatTime(draft.schedule.timeOfDay)}`}
              onPress={() => setTimePickerOpen((open) => !open)}
              className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            >
              <Text className="text-lg text-foreground">Time</Text>
              <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted">
                {formatTime(draft.schedule.timeOfDay)}
              </Text>
              <SymbolView
                name="chevron.right"
                size={14}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </Pressable>
            {timePickerOpen ? (
              <DateTimePicker
                value={timePickerValue(draft.schedule.timeOfDay)}
                mode="time"
                display={Platform.OS === "ios" ? "spinner" : "default"}
                onDismiss={() => setTimePickerOpen(false)}
                onValueChange={(_, selected) => {
                  const timeOfDay = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
                  setDraft({ ...draft, schedule: { ...draft.schedule, timeOfDay } });
                }}
              />
            ) : null}
            <SelectRow
              label="Repeat"
              value={repeatLabel(draft.schedule.weekdays)}
              borderTop
              actions={[
                {
                  id: "every_day",
                  title: "Every day",
                  state: draft.schedule.weekdays.length === 7 ? "on" : undefined,
                },
                {
                  id: "weekdays",
                  title: "Weekdays",
                  state: repeatLabel(draft.schedule.weekdays) === "Weekdays" ? "on" : undefined,
                },
                ...DAYS.map((day) => ({
                  id: String(day.index),
                  title: day.label,
                  attributes: { keepsMenuPresented: true },
                  state: draft.schedule.weekdays.includes(day.index) ? ("on" as const) : undefined,
                })),
              ]}
              onSelect={(id) => {
                const weekdays =
                  id === "every_day"
                    ? DAYS.map((day) => day.index)
                    : id === "weekdays"
                      ? [1, 2, 3, 4, 5]
                      : (() => {
                          const day = DAYS.find((item) => String(item.index) === id);
                          if (!day) return draft.schedule.weekdays;
                          return draft.schedule.weekdays.includes(day.index)
                            ? draft.schedule.weekdays.filter((index) => index !== day.index)
                            : [...draft.schedule.weekdays, day.index];
                        })();
                setDraft({ ...draft, schedule: { ...draft.schedule, weekdays } });
              }}
            />
          </>
        ) : (
          <>
            <FormField
              label="Minutes between runs"
              value={draft.schedule.intervalMinutes}
              keyboardType="decimal-pad"
              disabled={saving}
              borderTop
              onChange={(intervalMinutes) =>
                setDraft({ ...draft, schedule: { ...draft.schedule, intervalMinutes } })
              }
            />
            {Number(draft.schedule.intervalMinutes) < 1 ? (
              <Text className="px-4 pb-3 text-sm text-danger-foreground">
                Intervals must be at least 1 minute. Update this interval before saving.
              </Text>
            ) : draft.task?.schedule.type === "interval" && draft.task.schedule.everyMs < 60_000 ? (
              <Text className="px-4 pb-3 text-sm text-foreground-muted">
                This task previously ran more than once per minute. Saving requires an interval of
                at least 1 minute.
              </Text>
            ) : null}
          </>
        )}
        <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
          <Text className="min-w-0 flex-1 text-lg text-foreground">Enabled</Text>
          <ThemedSwitch
            accessibilityLabel="Task enabled"
            value={draft.enabled}
            onValueChange={(enabled) => setDraft({ ...draft, enabled })}
          />
        </View>
      </SettingsSection>
      {draft.schedule.mode === "fixed_time" ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Time uses the environment's time zone, which may differ from your phone's.
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{
          disabled: saving || dictationPending || taskMissing || environmentUnavailable,
        }}
        disabled={saving || dictationPending || taskMissing || environmentUnavailable}
        onPress={() => void save()}
        className="min-h-12 items-center justify-center rounded-[14px] bg-primary px-4 disabled:opacity-50"
      >
        <Text className="text-base font-t3-medium text-primary-foreground">
          {saving ? "Saving…" : draft.task ? "Save changes" : "Create task"}
        </Text>
      </Pressable>
    </View>
  );
}

function EnvironmentTasks({
  environment,
  now,
  projectIds,
  onEdit,
}: {
  readonly environment: SettingsTarget;
  readonly now: number;
  readonly projectIds: readonly ProjectId[] | null;
  readonly onEdit: (task: ScheduledTask) => void;
}) {
  const environmentId = environment.environmentId;
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const visibleTasks = tasks.data?.tasks.filter(
    (task) => projectIds === null || projectIds.includes(task.projectId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
    reportFailure: false,
  });
  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Alert.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const act = async (task: ScheduledTask, action: "run" | "toggle" | "delete") => {
    const result =
      action === "run"
        ? await runNow({ environmentId, input: { id: task.id } })
        : action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await remove({ environmentId, input: { id: task.id } });
    failure(`Could not ${action === "toggle" ? "update" : action} task`, result);
  };

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
      {tasks.error ? (
        <Text className="p-4 text-base text-danger-foreground">{tasks.error}</Text>
      ) : !tasks.data ? (
        <Text className="p-4 text-base text-foreground-muted">Loading tasks…</Text>
      ) : visibleTasks?.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {projectIds === null ? "No scheduled tasks yet." : "No tasks in this project."}
        </Text>
      ) : (
        visibleTasks?.map((task, index) => (
          <View
            key={task.id}
            className={
              index === 0
                ? "flex-row items-start gap-1 px-4 py-4"
                : "flex-row items-start gap-1 border-t border-border-subtle px-4 py-4"
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${task.title}`}
              onPress={() => {
                onEdit(task);
              }}
              className="min-w-0 flex-1 gap-1 active:opacity-70"
            >
              <Text className="text-lg font-t3-medium text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {describeSchedule(task)}
                {!task.enabled
                  ? " · Paused"
                  : task.nextRunAt
                    ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                    : ""}
              </Text>
              {task.lastRunError ? (
                <Text className="text-sm text-danger-foreground" numberOfLines={2}>
                  Last run failed: {task.lastRunError}
                </Text>
              ) : null}
            </Pressable>
            <ControlPillMenu
              actions={[
                { id: "edit", title: "Edit" },
                { id: "toggle", title: task.enabled ? "Pause" : "Resume" },
                { id: "run", title: "Run now" },
                { id: "delete", title: "Delete", attributes: { destructive: true } },
              ]}
              onPressAction={({ nativeEvent }) => {
                const action = nativeEvent.event;
                if (action === "edit") {
                  onEdit(task);
                } else if (action === "delete") {
                  Alert.alert("Delete task?", task.title, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => void act(task, "delete"),
                    },
                  ]);
                } else if (action === "toggle" || action === "run") {
                  void act(task, action);
                }
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Actions for ${task.title}`}
                className="h-11 w-11 items-center justify-center"
              >
                <SymbolView
                  name="ellipsis"
                  size={18}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
          </View>
        ))
      )}
    </SettingsSection>
  );
}

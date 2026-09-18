import type {
  EnvironmentId,
  EnvironmentMachineKind,
  ModelSelection,
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
import { useMemo, useState } from "react";
import { Alert, Platform, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { buildModelOptions } from "../../lib/modelOptions";
import { useProjects, useEnvironmentServerConfig, useServerConfigs } from "../../state/entities";
import { usePaginatedBranches } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  DEFAULT_SCHEDULE,
  scheduleDraftForTask,
  scheduleFromDraft,
  type ScheduleDraft,
} from "./scheduledTaskDraft";

const DAYS = [
  { index: 1, label: "Mon" },
  { index: 2, label: "Tue" },
  { index: 3, label: "Wed" },
  { index: 4, label: "Thu" },
  { index: 5, label: "Fri" },
  { index: 6, label: "Sat" },
  { index: 0, label: "Sun" },
] as const;

const MACHINE_ICON: Record<EnvironmentMachineKind, string> = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
};

type Workspace = "worktree" | "root" | "existing_worktree";
type Draft = {
  readonly task: ScheduledTask | null;
  readonly title: string;
  readonly prompt: string;
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
  readonly schedule: ScheduleDraft;
  readonly workspace: Workspace;
  readonly baseRef: string;
  readonly checkoutPath: string;
  readonly enabled: boolean;
};

function createDraft(projectId: ProjectId | null, modelSelection: ModelSelection | null): Draft {
  return {
    task: null,
    title: "",
    prompt: "",
    projectId,
    modelSelection,
    schedule: DEFAULT_SCHEDULE,
    workspace: "worktree",
    baseRef: "main",
    checkoutPath: "",
    enabled: true,
  };
}

function editDraft(task: ScheduledTask): Draft {
  return {
    task,
    title: task.title,
    prompt: task.prompt,
    projectId: task.projectId,
    modelSelection: task.modelSelection,
    schedule: scheduleDraftForTask(task),
    workspace: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    checkoutPath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    enabled: task.enabled,
  };
}

function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.type === "interval") return `Every ${task.schedule.everyMs / 60_000} minutes`;
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
  if (weekdays.length === 7) return "Every day";
  if (weekdays.length === 5 && [1, 2, 3, 4, 5].every((day) => weekdays.includes(day)))
    return "Weekdays";
  return (
    DAYS.filter((day) => weekdays.includes(day.index))
      .map((day) => day.label)
      .join(", ") || "Choose days"
  );
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly multiline?: boolean;
  readonly keyboardType?: "numeric";
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
        onChangeText={props.onChange}
        multiline={props.multiline}
        textAlignVertical={props.multiline ? "top" : "center"}
        keyboardType={props.keyboardType}
        placeholder={props.placeholder}
        placeholderTextColorClassName="text-foreground-muted"
        className={
          props.multiline
            ? "min-h-24 font-sans text-base text-foreground"
            : "min-h-8 font-sans text-base text-foreground"
        }
      />
    </View>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
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
        <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted">
          {props.value}
        </Text>
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
        <Text
          className="min-w-0 flex-1 text-right text-base text-foreground-muted"
          numberOfLines={1}
        >
          {props.value}
        </Text>
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

function BranchRow(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly value: string;
  readonly onChange: (branch: string) => void;
}) {
  const branches = usePaginatedBranches({
    environmentId: props.environmentId,
    cwd: props.cwd,
  });
  const names = [
    ...new Set([
      props.value,
      ...branches.refs.filter((branch) => !branch.isRemote).map((branch) => branch.name),
    ]),
  ];
  return (
    <>
      <SelectRow
        label="Base branch"
        value={props.value}
        borderTop
        actions={[
          ...names.filter(Boolean).map((name) => ({
            id: name,
            title: name,
            state: name === props.value ? ("on" as const) : undefined,
          })),
          ...(branches.data?.nextCursor != null
            ? [{ id: "__more__", title: "Load more branches" }]
            : []),
        ]}
        onSelect={(name) => {
          if (name === "__more__") branches.loadNext();
          else props.onChange(name);
        }}
      />
      {branches.error ? (
        <Pressable accessibilityRole="button" onPress={branches.refresh} className="px-4 pb-3">
          <Text className="text-sm text-danger-foreground">
            Could not load branches. Tap to retry.
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}

export function SettingsScheduledTasksRouteScreen() {
  const { selectedTargets, selectedProjectKey, projectGroups } = useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const selectableEnvironments = selectedTargets.filter(
    (environment) =>
      selectedProjectKey === null ||
      selectedGroup?.members.some(
        (member) => member.project.environmentId === environment.environmentId,
      ),
  );
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    chosenEnvironmentId &&
    selectableEnvironments.some((e) => e.environmentId === chosenEnvironmentId)
      ? chosenEnvironmentId
      : (selectableEnvironments[0]?.environmentId ?? null);
  const selectedEnvironment = selectableEnvironments.find((e) => e.environmentId === environmentId);
  const selectedConfig = useEnvironmentServerConfig(environmentId);
  const configs = useServerConfigs();
  const projects = useProjects();
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="Scheduled Tasks">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedEnvironment ? (
          <SettingsSection title="Runs on">
            <ControlPillMenu
              actions={selectableEnvironments.map((environment) => ({
                id: environment.environmentId,
                title: environment.label,
                subtitle:
                  environment.connection.phase === "connected"
                    ? (projects.find(
                        (project) => project.environmentId === environment.environmentId,
                      )?.title ?? "Connected")
                    : "Unavailable",
                image:
                  MACHINE_ICON[
                    resolveEnvironmentMachineKind(configs.get(environment.environmentId) ?? null)
                  ],
                state: environment.environmentId === environmentId ? "on" : undefined,
              }))}
              onPressAction={({ nativeEvent }) => {
                const environment = selectableEnvironments.find(
                  (e) => e.environmentId === nativeEvent.event,
                );
                if (environment) setChosenEnvironmentId(environment.environmentId);
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Environment, ${selectedEnvironment.label}`}
                className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              >
                <EnvironmentMachineSymbol
                  kind={resolveEnvironmentMachineKind(selectedConfig)}
                  size={20}
                  tintColorClassName="accent-icon"
                />
                <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                  {selectedEnvironment.label}
                </Text>
                <SymbolView
                  name="chevron.down"
                  size={14}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
          </SettingsSection>
        ) : null}
        {environmentId ? (
          <EnvironmentTasks
            key={`${environmentId}:${selectedProjectKey ?? ""}`}
            environmentId={environmentId}
            projectIds={
              selectedProjectKey === null
                ? null
                : (selectedGroup?.members
                    .filter((member) => member.project.environmentId === environmentId)
                    .map((member) => member.project.id) ?? [])
            }
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            No connected environments in this settings scope. Go back to Settings to change the
            scope.
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentTasks({
  environmentId,
  projectIds,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectIds: readonly ProjectId[] | null;
}) {
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      (projectIds === null || projectIds.includes(project.id)),
  );
  const visibleTasks = tasks.data?.tasks.filter(
    (task) => projectIds === null || projectIds.includes(task.projectId),
  );
  const config = useEnvironmentServerConfig(environmentId);
  const modelOptions = useMemo(() => buildModelOptions(config, null), [config]);
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
    reportFailure: false,
  });
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const taskMissing = draft?.task && !tasks.data?.tasks.some((task) => task.id === draft.task?.id);

  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Alert.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const save = async () => {
    if (!draft || saving || taskMissing) return;
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
    const input: ScheduledTaskUpsertInput = {
      ...(draft.task ? { id: draft.task.id } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      projectId: draft.projectId,
      modelSelection: draft.modelSelection,
      schedule,
      enabled: draft.enabled,
      threadId: draft.task?.threadId ?? null,
      workspaceStrategy:
        draft.workspace === "root"
          ? { type: "root" }
          : draft.workspace === "existing_worktree"
            ? { type: "existing_worktree", worktreePath: draft.checkoutPath.trim() }
            : {
                type: "worktree",
                baseRef: draft.baseRef.trim() || "main",
                startFromOrigin:
                  draft.task?.workspaceStrategy.type === "worktree"
                    ? draft.task.workspaceStrategy.startFromOrigin
                    : true,
              },
      runtimeMode: draft.task?.runtimeMode ?? "full-access",
      interactionMode: draft.task?.interactionMode ?? "default",
      creationSource: draft.task?.creationSource ?? "mobile",
    };
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      failure("Could not save task", result);
      return;
    }
    setDraft(null);
    setTimePickerOpen(false);
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

  return draft ? (
    <View className="gap-5">
      <View className="flex-row items-center justify-between gap-3 px-1">
        <Text accessibilityRole="header" className="text-2xl font-t3-semibold text-foreground">
          {draft.task ? "Edit task" : "New task"}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDraft(null);
            setTimePickerOpen(false);
          }}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-base text-primary">Cancel</Text>
        </Pressable>
      </View>
      {taskMissing ? (
        <Text className="px-1 text-base text-danger-foreground">This task no longer exists.</Text>
      ) : null}

      <SettingsSection title="Task">
        <FormField
          label="Name"
          value={draft.title}
          placeholder="Check for issues"
          onChange={(title) => setDraft({ ...draft, title })}
        />
        <FormField
          label="Prompt"
          value={draft.prompt}
          multiline
          borderTop
          placeholder="What should the agent do each time?"
          onChange={(prompt) => setDraft({ ...draft, prompt })}
        />
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
            if (project) setDraft({ ...draft, projectId: project.id });
          }}
        />
        <SelectRow
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
          actions={modelOptions.map((option) => ({
            id: option.key,
            title: `${option.providerLabel} · ${option.label}`,
            state:
              option.selection.instanceId === draft.modelSelection?.instanceId &&
              option.selection.model === draft.modelSelection?.model
                ? "on"
                : undefined,
          }))}
          onSelect={(id) => {
            const option = modelOptions.find((item) => item.key === id);
            if (option) setDraft({ ...draft, modelSelection: option.selection });
          }}
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
          <BranchRow
            environmentId={environmentId}
            cwd={projects.find((project) => project.id === draft.projectId)?.workspaceRoot ?? null}
            value={draft.baseRef}
            onChange={(baseRef) => setDraft({ ...draft, baseRef })}
          />
        ) : null}
        {draft.workspace === "existing_worktree" ? (
          <FormField
            label="Checkout path"
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
          <FormField
            label="Minutes between runs"
            value={draft.schedule.intervalMinutes}
            keyboardType="numeric"
            borderTop
            onChange={(intervalMinutes) =>
              setDraft({ ...draft, schedule: { ...draft.schedule, intervalMinutes } })
            }
          />
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
        accessibilityState={{ disabled: saving || !!taskMissing }}
        disabled={saving || !!taskMissing}
        onPress={() => void save()}
        className="min-h-12 items-center justify-center rounded-[14px] bg-primary px-4 disabled:opacity-50"
      >
        <Text className="text-base font-t3-medium text-primary-foreground">
          {saving ? "Saving…" : draft.task ? "Save changes" : "Create task"}
        </Text>
      </Pressable>
    </View>
  ) : (
    <SettingsSection title="Tasks">
      {tasks.error ? (
        <Text className="p-4 text-base text-danger-foreground">{tasks.error}</Text>
      ) : !tasks.data ? (
        <Text className="p-4 text-base text-foreground-muted">Loading tasks…</Text>
      ) : visibleTasks?.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          No scheduled tasks yet. Add one to run a prompt automatically.
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
                setDraft(editDraft(task));
                setTimePickerOpen(false);
              }}
              className="min-w-0 flex-1 gap-1 active:opacity-70"
            >
              <Text className="text-lg font-t3-medium text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {describeSchedule(task)}
                {task.enabled ? "" : " · Paused"}
              </Text>
              {task.nextRunAt && task.enabled ? (
                <Text className="text-sm text-foreground-muted">
                  Next run {new Date(task.nextRunAt).toLocaleString()}
                </Text>
              ) : null}
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
                  setDraft(editDraft(task));
                  setTimePickerOpen(false);
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
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setDraft(createDraft(projects[0]?.id ?? null, modelOptions[0]?.selection ?? null));
          setTimePickerOpen(false);
        }}
        className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
      >
        <SymbolView name="plus" size={18} tintColorClassName="accent-icon" type="monochrome" />
        <Text className="text-lg text-foreground">New task</Text>
      </Pressable>
    </SettingsSection>
  );
}

import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react-native";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import type {
  EnvironmentId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskThreadMode,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  resolveEnvironmentMachineKind,
  scheduledTaskThreadMode,
  trimAsciiWhitespace,
} from "@t3tools/contracts";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import type { MenuAction } from "@react-native-menu/menu";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { scheduledTaskWorktreeBaseRef } from "@t3tools/client-runtime/scheduled-task-worktree";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";
import {
  moveScheduledTask,
  orderScheduledTasks,
} from "@t3tools/client-runtime/scheduled-task-order";
import type { MessageResolver } from "../../i18n/messages";
import { useRef, useState, type ReactNode } from "react";
import { useFocusEffect, useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AppState, Platform, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  EnvironmentMachineSymbol,
  ENVIRONMENT_MACHINE_SYMBOLS,
} from "../../components/EnvironmentMachineSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { cn } from "../../lib/cn";
import { usePreparedConnection } from "../../state/session";
import { buildModelOptions } from "../../lib/modelOptions";
import { withImplicitFastModeSelection } from "../../lib/providerOptions";
import { useProjects, useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { usePaginatedBranches } from "../../state/queries";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { resolveNewTaskBranchLabel } from "../threads/new-task-context-presentation";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { ScheduledTaskPromptField } from "./components/ScheduledTaskPromptField";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import {
  changeDraftProject,
  editDraft,
  parseIntervalMinutes,
  scheduledTaskDefaultModel,
  scheduleFromDraft,
  unbindDraftFromThread,
  type ScheduledTaskDraft as Draft,
} from "./scheduledTaskDraft";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";
import {
  useScheduledTaskDestinationLabel,
  useScheduledTaskEditor,
  useScheduledTaskThread,
} from "./scheduled-task-editor";
import {
  discardScheduledTaskEditor,
  markScheduledTaskEditorSaved,
} from "./scheduled-task-editor-state";
import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

type ScheduledTaskRoutes = {
  SettingsScheduledTaskNew: undefined;
  SettingsScheduledTaskEdit: undefined;
  SettingsScheduledTaskModel: undefined;
  SettingsScheduledTaskBranch: undefined;
  SettingsScheduledTaskThread: undefined;
};

const DAYS = [1, 2, 3, 4, 5, 6, 0].map((index) => ({ index }));

// 2024-01-07 was a Sunday, so day index 0 to 6 maps onto Sunday to Saturday.
function weekdayLabel(index: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    Date.UTC(2024, 0, 7 + index),
  );
}

const THREAD_MODE_LABELS: Record<ScheduledTaskThreadMode, string> = {
  new_thread: msg("New thread each run"),
  continue: msg("One thread, same conversation"),
  fresh_session: msg("One thread, fresh session"),
};

function describeSchedule(
  task: ScheduledTask,
  timeZone: string | undefined,
  resolve: MessageResolver,
  locale: string,
): string {
  if (task.schedule.type === "webhook") return resolve(msg("On webhook"));
  if (task.schedule.type === "once") {
    const runAt = new Date(task.schedule.runAt);
    return resolve(
      msg("Once, {date} at {time}", { date: formatRunAtDate(runAt), time: formatRunAtTime(runAt) }),
    );
  }
  if (task.schedule.type === "interval")
    return formatScheduledTaskInterval(task.schedule.everyMs, resolve);
  const days = task.schedule.weekdays?.length
    ? repeatLabel(task.schedule.weekdays, resolve, locale)
    : resolve(msg("Every day"));
  const zone = scheduleTimeZoneLabel(timeZone, task.nextRunAt);
  const time = formatTime(task.schedule.timeOfDay);
  return zone === undefined
    ? resolve(msg("{days} at {time}", { days, time }))
    : resolve(msg("{days} at {time} {zone}", { days, time, zone }));
}

// A stored wall time names no date or zone, so format it in UTC where nothing can shift it.
function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  return new Date(Date.UTC(2000, 0, 1, hours ?? 9, minutes ?? 0)).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function formatRunAtDate(value: Date): string {
  return value.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatRunAtTime(value: Date): string {
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function timePickerValue(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);
  // Native pickers read local hours, and 2000-01-01 has no DST change in any zone, unlike today.
  const time = new Date(2000, 0, 1);
  time.setHours(
    Number.isInteger(hours) ? (hours ?? 9) : 9,
    Number.isInteger(minutes) ? (minutes ?? 0) : 0,
    0,
    0,
  );
  return time;
}

function isWeekdays(weekdays: ReadonlyArray<number>): boolean {
  const days = new Set(weekdays);
  return days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day));
}

function repeatLabel(
  weekdays: ReadonlyArray<number>,
  resolve: MessageResolver,
  locale: string,
): string {
  const days = new Set(weekdays);
  if (days.size === 7) return resolve(msg("Every day"));
  if (isWeekdays(weekdays)) return resolve(msg("Weekdays"));
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => weekdayLabel(day.index, locale))
      .join(", ") || resolve(msg("Choose days"))
  );
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly keyboardType?: "decimal-pad" | "number-pad";
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
  const gt = useGT();
  const value = (
    <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
      {props.valueIcon}
      <Text
        textRole="footnote"
        className="shrink text-right text-foreground-muted"
        numberOfLines={1}
      >
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
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
      </View>
    );
  }
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("{label}, {value}", { label: props.label, value: props.value })}
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        }
      >
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

function WebhookFilterRows(props: {
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  readonly disabled: boolean;
  readonly onChange: (
    update: (filters: ReadonlyArray<WebhookFilterDraft>) => ReadonlyArray<WebhookFilterDraft>,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const update = (id: WebhookFilterDraft["id"], patch: Partial<WebhookFilterDraft>) =>
    props.onChange((filters) =>
      filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)),
    );
  return (
    <>
      {props.filters.map((filter, index) => (
        <View key={filter.id}>
          <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 pt-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
              <T>
                Filter <Var>{index + 1}</Var>
              </T>
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Remove filter {number}", { number: index + 1 })}
              disabled={props.disabled}
              hitSlop={8}
              onPress={() =>
                props.onChange((filters) => removeWebhookFilterDraft(filters, filter.id))
              }
              className="active:opacity-70"
            >
              <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
            </Pressable>
          </View>
          <FormField
            label={gt("Path", { $context: "webhook payload field path" })}
            value={filter.path}
            placeholder="body.action"
            disabled={props.disabled}
            onChange={(path) => update(filter.id, { path })}
          />
          <SelectRow
            label={gt("Test", { $context: "noun, the comparison a webhook filter applies" })}
            value={m(WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label ?? "")}
            actions={WEBHOOK_FILTER_OPS.map((option) => ({
              id: option.op,
              title: m(option.label),
              state: option.op === filter.op ? ("on" as const) : undefined,
            }))}
            onSelect={(id) => {
              const known = WEBHOOK_FILTER_OPS.find((option) => option.op === id);
              if (known) update(filter.id, { op: known.op });
            }}
          />
          {filter.op === "exists" ? null : (
            <FormField
              label={filter.op === "in" ? gt("Values, comma-separated") : gt("Value")}
              value={filter.value}
              // oxlint-disable-next-line t3code/no-untranslated-copy -- webhook action values
              placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
              disabled={props.disabled}
              onChange={(value) => update(filter.id, { value })}
            />
          )}
        </View>
      ))}
      {props.filters.length < MAX_WEBHOOK_FILTERS ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() =>
            props.onChange((filters) =>
              filters.length < MAX_WEBHOOK_FILTERS
                ? [...filters, emptyWebhookFilterDraft()]
                : filters,
            )
          }
          className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
        >
          <Text textRole="body" className="min-w-0 flex-1 text-foreground">
            <T>Add filter</T>
          </Text>
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      ) : null}
      {props.filters.length > 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          <T>
            Runs only when every filter matches. Other requests are logged as filtered. Separate “is
            one of” values with commas; a value can't contain a comma.
          </T>
        </Text>
      ) : null}
    </>
  );
}

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{label}, {value}", { label: props.label, value: props.value })}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text textRole="body" className="text-foreground">
        {props.label}
      </Text>
      <Text
        textRole="footnote"
        className="min-w-0 flex-1 text-right text-foreground-muted"
        numberOfLines={1}
      >
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
  const gt = useGT();
  const [now, setNow] = useState(Date.now);
  useFocusEffect(() => {
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
  });
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
  const environmentMenu = useSettingsEnvironmentMenu();
  const newTask = () => {
    if (visibleEnvironments.length === 0) return;
    resetEditor();
    navigation.navigate("SettingsScheduledTaskNew");
  };

  return (
    <SettingsScreen
      title={gt("Scheduled tasks")}
      actions={[
        {
          accessibilityLabel: gt("New task"),
          icon: "plus",
          disabled: visibleEnvironments.length === 0,
          onPress: newTask,
        },
      ]}
      menus={[environmentMenu]}
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
              ? gt("Connect an environment to view and create scheduled tasks.")
              : gt("No environments match these filters. Change the filter above.")}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

// The "New task" action and takeScheduledTaskNewLink clear the editor before
// this screen opens, so it starts from the default target.
export function SettingsScheduledTaskNewRouteScreen() {
  const gt = useGT();
  return <SettingsScheduledTaskEditorScreen title={gt("New scheduled task")} />;
}

export function SettingsScheduledTaskEditRouteScreen() {
  const gt = useGT();
  return <SettingsScheduledTaskEditorScreen title={gt("Edit scheduled task")} />;
}

function SettingsScheduledTaskEditorScreen({ title }: { readonly title: string }) {
  const gt = useGT();
  const {
    editor,
    voiceOwnerKey,
    readEditor,
    setEditor,
    hasChanges,
    saving,
    setSaving,
    draftForEnvironment,
  } = useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // Set once the save lands, so the removal guard lets the editor close.
  const saved = useRef(false);
  const ownerKey = editor ? `${voiceOwnerKey}:${editor.environmentId}` : null;
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
    label: editor?.draft.title.trim() || title,
    selection,
    readDraftMessage: () => {
      const current = readEditor();
      if (current?.environmentId !== editor?.environmentId) return null;
      return current?.draft.prompt ?? null;
    },
    onChangeSelection: setSelection,
    onChangeDraftMessage: (text) => {
      if (readEditor()?.environmentId === editor?.environmentId) setPrompt(text);
    },
    disabled: saving,
  });
  const preventRemove = hasChanges || saving;
  usePreventRemove(preventRemove, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert(gt("Saving task"), gt("Wait for the task to finish saving before leaving."));
      return;
    }
    Dialog.alert(gt("Discard changes?"), gt("Your unsaved changes will be lost."), [
      { text: gt("Keep editing"), style: "cancel" },
      {
        text: gt("Discard changes"),
        style: "destructive",
        onPress: () => {
          if (voiceInput.isBusy) voiceInput.cancel();
          discardScheduledTaskEditor();
          navigation.dispatch(data.action);
        },
      },
    ]);
  });
  return (
    <SettingsScreen
      title={title}
      // Native Back pops before removal guards; a bar action lets the guard run first.
      guardBack={preventRemove}
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
            setDraft={(update) => {
              if (!saving)
                setEditor((current) =>
                  current ? { ...current, draft: update(current.draft) } : current,
                );
            }}
            setEnvironmentDraft={(update) => {
              if (!saving)
                setEditor((current) =>
                  current && current.environmentId === editor.environmentId
                    ? { ...current, draft: update(current.draft) }
                    : current,
                );
            }}
            onSaved={() => {
              saved.current = true;
              markScheduledTaskEditorSaved();
              if (navigation.isFocused()) navigation.goBack();
            }}
            onChangeEnvironment={(target) => {
              setEditor((current) =>
                !current || target.environmentId === current.environmentId
                  ? current
                  : {
                      environmentId: target.environmentId,
                      environmentLabel: target.label,
                      draft: {
                        ...draftForEnvironment(target.environmentId),
                        title: current.draft.title,
                        prompt: current.draft.prompt,
                        schedule: current.draft.schedule,
                        enabled: current.draft.enabled,
                      },
                    },
              );
            }}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? gt("Connect an environment to create a scheduled task.")
              : gt(
                  "No environments match the current filters. Change the filters to create a task.",
                )}
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
  setEnvironmentDraft,
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
  readonly setDraft: (update: (current: Draft) => Draft) => void;
  readonly setEnvironmentDraft: (update: (current: Draft) => Draft) => void;
  readonly onSaved: () => void;
  readonly onChangeEnvironment: (target: SettingsTarget) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const { readEditor } = useScheduledTaskEditor();
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  // Pinned first. The chosen project stays listed after it is archived.
  const projects = useProjects()
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        (project.archivedAt == null ||
          project.id === draft.projectId ||
          project.id === draft.task?.projectId),
    )
    .sort((left, right) => Number(right.pinnedAt != null) - Number(left.pinnedAt != null));
  const automaticBaseRef = draft.workspace === "worktree" && !trimAsciiWhitespace(draft.baseRef);
  const automaticBaseRefCwd = automaticBaseRef
    ? (projects.find((project) => project.id === draft.projectId)?.workspaceRoot ?? null)
    : null;
  const automaticBaseRefs = usePaginatedBranches({
    environmentId,
    cwd: automaticBaseRefCwd,
    query: "",
  });
  const worktreeBaseRef = scheduledTaskWorktreeBaseRef(draft.baseRef, automaticBaseRefs.refs);
  // Until the project's refs load, the automatic base would save as `main`. A failed lookup falls back to it.
  const automaticBaseRefLoading =
    automaticBaseRefCwd !== null &&
    automaticBaseRefs.data === null &&
    automaticBaseRefs.error === null;
  const config = useEnvironmentServerConfig(environmentId);
  const destinationLabel = useScheduledTaskDestinationLabel(environmentId, draft.threadId);
  const boundThread = useScheduledTaskThread(environmentId, draft.threadId);
  // Bound runs use the thread's current model, so the locked row shows that one.
  const shownSelection =
    draft.threadId === null ? draft.modelSelection : (boundThread?.modelSelection ?? null);
  const modelOptions = buildModelOptions(config, null, undefined, draft.projectId);
  // Existing webhook tasks keep the option so they can still switch to a timer.
  const webhookDenial = managedCapabilityDenial(config?.managedPolicy, "webhookTasks", m);
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
    reportFailure: false,
  });
  const submissionPending = useRef(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [runAtPicker, setRunAtPicker] = useState<"date" | "time" | null>(null);
  const taskMissing =
    draft.task !== null &&
    tasks.data !== null &&
    !tasks.data.tasks.some((task) => task.id === draft.task?.id);
  const runAtZone = scheduleTimeZoneLabel(tasks.data?.timeZone);
  const environmentUnavailable = !availableTargets.some(
    (target) => target.environmentId === environmentId,
  );

  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const offersOnce =
    config?.environment.capabilities.oneTimeSchedules === true ||
    draft.task?.schedule.type === "once";
  const offersThreadModes = config?.environment.capabilities.scheduledTaskThreadModes === true;
  const save = async () => {
    const current = readEditor();
    if (!current || current.environmentId !== environmentId) return;
    const draft = current.draft;
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      dictationPending ||
      taskMissing ||
      environmentUnavailable ||
      automaticBaseRefLoading
    )
      return;
    // Preserve signatures edited on other clients by sending the task's current value.
    const liveTask = tasks.data?.tasks.find((task) => task.id === draft.task?.id);
    const schedule = scheduleFromDraft(
      draft.schedule.mode === "webhook" && liveTask?.schedule.type === "webhook"
        ? { ...draft.schedule, signature: liveTask.schedule.signature }
        : draft.schedule,
    );
    if (
      draft.schedule.mode === "webhook" &&
      parseMaxDeliveryAge(draft.schedule.maxDeliveryAgeMinutes) === undefined
    ) {
      Dialog.alert(
        gt("Invalid age limit"),
        gt("Enter whole minutes from 1 to {max}, or leave it blank.", {
          max: MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
        }),
      );
      return;
    }
    if (draft.schedule.mode === "once" && !offersOnce) {
      Dialog.alert(
        gt("Once is not available here"),
        gt(
          "This environment runs an older {product}. Update it to schedule a one-time task, or pick another schedule.",
          { product: "T3 Code" },
        ),
      );
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.schedule.filters, m);
    if (draft.schedule.mode === "webhook" && "error" in parsedFilters) {
      Dialog.alert(gt("Invalid filter"), parsedFilters.error);
      return;
    }
    if (draft.schedule.mode === "webhook" && schedule === null) {
      Dialog.alert(
        gt("Invalid webhook settings"),
        gt(
          "Each dedupe key must contain a valid request placeholder. The coalesce window must be whole seconds from 10 to 3600, or blank.",
        ),
      );
      return;
    }
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !draft.projectId ||
      !draft.modelSelection ||
      !schedule ||
      (draft.workspace === "existing_worktree" && !draft.checkoutPath.trim())
    ) {
      Dialog.alert(
        gt("Incomplete task"),
        gt("Add a name, prompt, project, model, valid schedule, and checkout path if needed."),
      );
      return;
    }
    if (!projects.some((project) => project.id === draft.projectId)) {
      Dialog.alert(gt("Project unavailable"), gt("Choose a project in this environment."));
      return;
    }
    const input: ScheduledTaskUpsertInput = {
      ...(draft.task ? { id: draft.task.id, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      projectId: draft.projectId,
      modelSelection: withImplicitFastModeSelection(draft.modelSelection, config?.providers ?? []),
      schedule,
      enabled: draft.enabled,
      threadId: draft.threadId,
      ...(draft.threadId === null && draft.task?.threadId != null ? { unbindThread: true } : {}),
      ...(offersThreadModes ? { threadMode: draft.threadMode } : {}),
      workspaceStrategy:
        draft.workspace === "root"
          ? { type: "root" }
          : draft.workspace === "existing_worktree"
            ? { type: "existing_worktree", worktreePath: draft.checkoutPath.trim() }
            : {
                type: "worktree",
                baseRef: worktreeBaseRef,
                startFromOrigin: draft.startFromOrigin,
              },
      // Tasks have no mode picker; a mode above the administrator's ceiling is refused.
      runtimeMode:
        clampManagedRuntimeMode(config?.managedPolicy, draft.runtimeMode) ?? draft.runtimeMode,
      interactionMode: draft.task?.interactionMode ?? "default",
      creationSource: draft.task?.creationSource ?? "mobile",
    };
    submissionPending.current = true;
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      failure(gt("Could not save task"), result);
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
        {taskMissing ? (
          <Text className="px-1 text-base text-danger-foreground">
            <T>This task no longer exists.</T>
          </Text>
        ) : null}

        {environmentUnavailable ? (
          <Text className="px-1 text-base text-danger-foreground">
            <T>This environment is disconnected. Reconnect before saving.</T>
          </Text>
        ) : null}
        <SettingsSection>
          <SelectRow
            label={gt("Runs on")}
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
                      ENVIRONMENT_MACHINE_SYMBOLS[
                        resolveEnvironmentMachineKind(target.serverConfig)
                      ],
                    state: target.environmentId === environmentId ? "on" : undefined,
                  }))
            }
            onSelect={(id) => {
              const target = availableTargets.find((entry) => entry.environmentId === id);
              if (target) onChangeEnvironment(target);
            }}
          />
        </SettingsSection>
        <SettingsSection title={gt("Task", { $context: "section heading for a scheduled task" })}>
          <FormField
            label={gt("Name")}
            disabled={saving}
            value={draft.title}
            placeholder={gt("Check for issues")}
            onChange={(title) => setDraft((current) => ({ ...current, title }))}
          />
          {promptField}
        </SettingsSection>

        <SettingsSection title={gt("Context", { $context: "section heading: project and model" })}>
          <SelectRow
            label={gt("Project")}
            value={
              projects.find((project) => project.id === draft.projectId)?.title ??
              (projects.length ? gt("Choose project") : gt("No projects available"))
            }
            actions={projects.map((project) => ({
              id: project.id,
              title: project.title,
              state: project.id === draft.projectId ? "on" : undefined,
            }))}
            onSelect={(id) => {
              const project = projects.find((item) => item.id === id);
              if (!project) return;
              setEnvironmentDraft((current) => {
                const keepsExplicitModel =
                  current.modelSelectionIsExplicit &&
                  (current.modelSelection === null ||
                    !config?.settings ||
                    resolveProjectProviderInstanceEnabled(
                      config.settings,
                      project.id,
                      current.modelSelection.instanceId,
                    ));
                return {
                  ...changeDraftProject(current, project.id),
                  modelSelection: keepsExplicitModel
                    ? current.modelSelection
                    : scheduledTaskDefaultModel(config, project),
                  modelSelectionIsExplicit: keepsExplicitModel,
                };
              });
            }}
          />
          <PickerRow
            label={gt("Model")}
            borderTop
            value={
              modelOptions.find(
                (option) =>
                  option.selection.instanceId === shownSelection?.instanceId &&
                  option.selection.model === shownSelection?.model,
              )?.label ??
              shownSelection?.model ??
              (modelOptions.length ? gt("Choose model") : gt("No models available"))
            }
            onPress={() => navigation.navigate("SettingsScheduledTaskModel")}
            // The saved selection only seeds new threads; bound runs ignore it.
            disabled={
              saving || dictationPending || environmentUnavailable || draft.threadId !== null
            }
          />
        </SettingsSection>

        <SettingsSection
          title={gt("Destination")}
          footer={
            draft.threadMode === "new_thread"
              ? gt("Each run starts a new thread.")
              : draft.threadMode === "continue"
                ? draft.threadId === null
                  ? gt(
                      "Runs continue one conversation. The first run starts the thread. Deleting it also deletes this task.",
                    )
                  : gt("Runs continue one conversation. Deleting it also deletes this task.")
                : draft.threadId === null
                  ? gt(
                      "Runs share one thread, each in a fresh session without earlier runs' context. The first run starts the thread. Deleting it also deletes this task.",
                    )
                  : gt(
                      "Runs share one thread, each in a fresh session without earlier runs' context. Deleting it also deletes this task.",
                    )
          }
        >
          {offersThreadModes ? (
            <SelectRow
              label={gt("Runs go to")}
              value={m(THREAD_MODE_LABELS[draft.threadMode])}
              actions={(Object.keys(THREAD_MODE_LABELS) as ScheduledTaskThreadMode[]).map(
                (mode) => ({
                  id: mode,
                  title: m(THREAD_MODE_LABELS[mode]),
                  state: draft.threadMode === mode ? "on" : undefined,
                }),
              )}
              onSelect={(id) => {
                if (id === "new_thread")
                  setDraft((current) => ({ ...unbindDraftFromThread(current), threadMode: id }));
                else if (id === "continue" || id === "fresh_session")
                  setDraft((current) => ({ ...current, threadMode: id }));
              }}
            />
          ) : null}
          {!offersThreadModes || draft.threadMode !== "new_thread" ? (
            <PickerRow
              label={gt("Thread")}
              borderTop={offersThreadModes}
              value={
                draft.threadId === null && draft.threadMode !== "new_thread"
                  ? gt("Started by the first run")
                  : destinationLabel
              }
              onPress={() => navigation.navigate("SettingsScheduledTaskThread")}
              disabled={!draft.projectId || saving || dictationPending || environmentUnavailable}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title={gt("Workspace")}>
          <SelectRow
            label={gt("Run in")}
            value={
              draft.workspace === "worktree"
                ? gt("New worktree")
                : draft.workspace === "root"
                  ? gt("Project checkout")
                  : gt("Specific checkout")
            }
            actions={[
              {
                id: "worktree",
                title: gt("New worktree"),
                state: draft.workspace === "worktree" ? "on" : undefined,
              },
              {
                id: "root",
                title: gt("Project checkout"),
                state: draft.workspace === "root" ? "on" : undefined,
              },
              {
                id: "existing_worktree",
                title: gt("Specific checkout"),
                state: draft.workspace === "existing_worktree" ? "on" : undefined,
              },
            ]}
            onSelect={(id) => {
              if (id === "worktree" || id === "root" || id === "existing_worktree")
                setDraft((current) => ({ ...current, workspace: id }));
            }}
          />
          {draft.workspace === "worktree" ? (
            <PickerRow
              label={gt("Base branch")}
              value={resolveNewTaskBranchLabel(
                {
                  branchName: automaticBaseRefLoading ? null : worktreeBaseRef,
                  startFromOrigin: draft.startFromOrigin,
                  workspaceMode: "worktree",
                },
                m,
              )}
              borderTop
              disabled={!draft.projectId || saving || dictationPending || environmentUnavailable}
              onPress={() => navigation.navigate("SettingsScheduledTaskBranch")}
            />
          ) : null}
          {draft.workspace === "existing_worktree" ? (
            <FormField
              label={gt("Checkout path")}
              disabled={saving}
              value={draft.checkoutPath}
              borderTop
              onChange={(checkoutPath) =>
                setEnvironmentDraft((current) => ({
                  ...current,
                  checkoutPath: resolvePastedPath(current.checkoutPath, checkoutPath),
                }))
              }
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title={gt("Schedule", { $context: "noun, section heading" })}>
          <View className="px-4 py-3">
            <SegmentedControl
              variant="card"
              options={[
                { value: "fixed_time", label: gt("At a time") },
                // Older servers reject one-time schedules on save.
                ...(offersOnce || draft.schedule.mode === "once"
                  ? [
                      {
                        value: "once" as const,
                        label: gt("Once", { $context: "one-time schedule option" }),
                      },
                    ]
                  : []),
                { value: "interval", label: gt("Interval") },
                ...(webhookDenial === undefined || draft.schedule.mode === "webhook"
                  ? [{ value: "webhook" as const, label: gt("On webhook") }]
                  : []),
              ]}
              selected={draft.schedule.mode}
              onSelect={(mode) => {
                setTimePickerOpen(false);
                setRunAtPicker(null);
                setDraft((current) => ({
                  ...current,
                  prompt:
                    mode === "webhook" && !current.prompt.trim()
                      ? DEFAULT_WEBHOOK_PROMPT
                      : current.prompt,
                  schedule: {
                    ...current.schedule,
                    mode,
                    runAt:
                      mode === "once" && !current.schedule.runAt
                        ? new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString()
                        : current.schedule.runAt,
                  },
                }));
              }}
            />
          </View>
          {draft.schedule.mode === "fixed_time" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  runAtZone
                    ? gt("Time, {time} {zone}", {
                        time: formatTime(draft.schedule.timeOfDay),
                        zone: runAtZone,
                      })
                    : gt("Time, {time}", { time: formatTime(draft.schedule.timeOfDay) })
                }
                onPress={() => setTimePickerOpen((open) => !open)}
                className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
              >
                <Text textRole="body" className="text-foreground">
                  {gt("Time", { $context: "time of day" })}
                </Text>
                <Text
                  textRole="footnote"
                  className="min-w-0 flex-1 text-right text-foreground-muted"
                >
                  {formatTime(draft.schedule.timeOfDay)}
                  {runAtZone ? ` ${runAtZone}` : ""}
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
                    if (Platform.OS === "android") setTimePickerOpen(false);
                    const timeOfDay = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
                    setDraft((current) => ({
                      ...current,
                      schedule: { ...current.schedule, timeOfDay },
                    }));
                  }}
                />
              ) : null}
              <SelectRow
                label={gt("Repeat", { $context: "noun, which days a task repeats on" })}
                value={repeatLabel(draft.schedule.weekdays, m, locale)}
                borderTop
                actions={[
                  {
                    id: "every_day",
                    title: gt("Every day"),
                    state: draft.schedule.weekdays.length === 7 ? "on" : undefined,
                  },
                  {
                    id: "weekdays",
                    title: gt("Weekdays"),
                    state: isWeekdays(draft.schedule.weekdays) ? "on" : undefined,
                  },
                  ...DAYS.map((day) => ({
                    id: String(day.index),
                    title: weekdayLabel(day.index, locale),
                    attributes: { keepsMenuPresented: true },
                    state: draft.schedule.weekdays.includes(day.index)
                      ? ("on" as const)
                      : undefined,
                  })),
                ]}
                onSelect={(id) => {
                  setDraft((current) => {
                    const weekdays =
                      id === "every_day"
                        ? DAYS.map((day) => day.index)
                        : id === "weekdays"
                          ? [1, 2, 3, 4, 5]
                          : (() => {
                              const day = DAYS.find((item) => String(item.index) === id);
                              if (!day) return current.schedule.weekdays;
                              return current.schedule.weekdays.includes(day.index)
                                ? current.schedule.weekdays.filter((index) => index !== day.index)
                                : [...current.schedule.weekdays, day.index];
                            })();
                    return { ...current, schedule: { ...current.schedule, weekdays } };
                  });
                }}
              />
            </>
          ) : draft.schedule.mode === "webhook" && webhookDenial !== undefined && draft.enabled ? (
            <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
              {gt("{reason} Switch the task to a timer, or turn it off, to save it.", {
                reason: webhookDenial,
              })}
            </Text>
          ) : draft.schedule.mode === "once" ? (
            (["date", "time"] as const).map((field) => {
              const runAt = new Date(draft.schedule.runAt);
              const label = field === "date" ? formatRunAtDate(runAt) : formatRunAtTime(runAt);
              return (
                <View key={field}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      field === "date"
                        ? gt("Date, {date}", { date: label })
                        : gt("Time, {time}", { time: label })
                    }
                    onPress={() => setRunAtPicker((open) => (open === field ? null : field))}
                    className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
                  >
                    <Text textRole="body" className="text-foreground">
                      {field === "date" ? gt("Date") : gt("Time", { $context: "time of day" })}
                    </Text>
                    <Text
                      textRole="footnote"
                      className="min-w-0 flex-1 text-right text-foreground-muted"
                    >
                      {label}
                    </Text>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColorClassName="accent-chevron"
                      type="monochrome"
                    />
                  </Pressable>
                  {runAtPicker === field ? (
                    <DateTimePicker
                      value={runAt}
                      mode={field}
                      display={Platform.OS === "ios" ? "spinner" : "default"}
                      onDismiss={() => setRunAtPicker(null)}
                      onValueChange={(_, selected) => {
                        // Android shows a dialog that closes on pick; iOS stays inline.
                        if (Platform.OS === "android") setRunAtPicker(null);
                        setDraft((current) => ({
                          ...current,
                          schedule: { ...current.schedule, runAt: selected.toISOString() },
                        }));
                      }}
                    />
                  ) : null}
                </View>
              );
            })
          ) : draft.schedule.mode === "webhook" ? (
            <>
              <WebhookScheduleDetails
                environmentId={environmentId}
                // Use the live row for rotated URLs; hide the URL once a loaded list no longer contains the task.
                task={
                  tasks.data
                    ? (tasks.data.tasks.find((task) => task.id === draft.task?.id) ?? null)
                    : draft.task
                }
                signatureConfigured={draft.schedule.signature !== null}
                disabled={!canOperate || saving || environmentUnavailable}
              />
              <FormField
                label={gt("Skip requests older than (minutes)")}
                value={draft.schedule.maxDeliveryAgeMinutes}
                placeholder={gt("Run every request")}
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(maxDeliveryAgeMinutes) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, maxDeliveryAgeMinutes },
                  }))
                }
              />
              <WebhookFilterRows
                filters={draft.schedule.filters}
                disabled={saving}
                onChange={(update) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, filters: update(current.schedule.filters) },
                  }))
                }
              />
              <FormField
                label={gt("Duplicate request key")}
                value={draft.schedule.replayKey}
                placeholder="{{headers.delivery-id}}"
                disabled={saving}
                borderTop
                onChange={(replayKey) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, replayKey },
                  }))
                }
              />
              <Text className="px-4 pb-3 text-sm text-foreground-muted">
                <T>Requests with the same key run only once within 7 days.</T>
              </Text>
              <FormField
                label={gt("Coalesce key template")}
                value={draft.schedule.coalesceKey}
                placeholder="{{body.id}}"
                disabled={saving}
                borderTop
                onChange={(coalesceKey) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, coalesceKey },
                  }))
                }
              />
              <FormField
                label={gt("Coalesce window (seconds, 10–3600)")}
                value={draft.schedule.coalesceWindowSeconds}
                placeholder="120"
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(coalesceWindowSeconds) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, coalesceWindowSeconds },
                  }))
                }
              />
              <Text className="px-4 pb-3 text-sm text-foreground-muted">
                <T>
                  Coalescing runs the latest payload when the window from the first delivery closes.
                  Empty keys run normally.
                </T>
              </Text>
            </>
          ) : (
            <>
              <FormField
                label={gt("Minutes between runs")}
                value={draft.schedule.intervalMinutes}
                keyboardType="decimal-pad"
                disabled={saving}
                borderTop
                onChange={(intervalMinutes) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, intervalMinutes },
                  }))
                }
              />
              {!(parseIntervalMinutes(draft.schedule.intervalMinutes) >= 1) ? (
                <Text className="px-4 pb-3 text-sm text-danger-foreground">
                  <T>Intervals must be at least 1 minute. Update this interval before saving.</T>
                </Text>
              ) : draft.task?.schedule.type === "interval" &&
                draft.task.schedule.everyMs < 60_000 ? (
                <Text className="px-4 pb-3 text-sm text-foreground-muted">
                  <T>
                    This task previously ran more than once per minute. Saving requires an interval
                    of at least 1 minute.
                  </T>
                </Text>
              ) : null}
            </>
          )}
          <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
            <Text textRole="body" className="min-w-0 flex-1 text-foreground">
              {gt("Enabled", { $context: "switch label, whether the task runs" })}
            </Text>
            <ThemedSwitch
              accessibilityLabel={gt("Task enabled")}
              value={draft.enabled}
              onValueChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </View>
        </SettingsSection>
        {draft.schedule.mode === "fixed_time" ? (
          <Text className="px-2 text-sm text-foreground-muted">
            <T>Time uses the environment's time zone, which may differ from your phone's.</T>
          </Text>
        ) : null}
      </View>
      <Button
        tone="primary"
        fullWidth
        loading={saving}
        disabled={
          !canOperate ||
          dictationPending ||
          taskMissing ||
          environmentUnavailable ||
          automaticBaseRefLoading ||
          // The server refuses an enabled webhook task under this policy.
          (draft.enabled && draft.schedule.mode === "webhook" && webhookDenial !== undefined)
        }
        onPress={() => void save()}
        label={saving ? gt("Saving…") : draft.task ? gt("Save changes") : gt("Create task")}
      />
    </View>
  );
}

function WebhookScheduleDetails({
  environmentId,
  task,
  signatureConfigured,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly signatureConfigured: boolean;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const [rotating, setRotating] = useState(false);
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const webhook = task?.schedule.type === "webhook" ? task.webhook : undefined;
  const resolved = webhook ? webhookAddress(webhook, httpBaseUrl, m) : null;
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        {gt(
          "The prompt can use {body}, {headers}, {query}, {wholeBody} and {request}. The filled-in prompt is all the agent sees.",
          {
            body: "{{body.a.b}}",
            headers: "{{headers.name}}",
            query: "{{query.name}}",
            wholeBody: "{{body}}",
            request: "{{request}}",
          },
        )}
      </Text>
      {task === null || resolved === null ? (
        <Text className="text-sm text-foreground-muted">
          <T>Save the task to get its webhook URL.</T>
        </Text>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Copy webhook URL")}
            accessibilityHint={gt("Copies the URL to the clipboard")}
            disabled={!resolved.copyable}
            onPress={() => void tryCopyTextWithHaptic(resolved.address)}
            className="gap-1 active:opacity-70"
          >
            <Text textRole="body" className="text-foreground">
              {resolved.copyable ? gt("Webhook URL") : gt("Webhook path")}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={2} selectable>
              {resolved.address}
            </Text>
          </Pressable>
          {resolved.note !== null ? (
            <Text className="text-sm text-foreground-muted">{resolved.note}</Text>
          ) : null}
          <Button
            label={rotating ? gt("Rotating…") : gt("Rotate URL")}
            tone="danger"
            disabled={disabled || rotating}
            onPress={() =>
              Dialog.alert(gt("Rotate URL?"), gt("The current URL stops working immediately."), [
                { text: gt("Cancel"), style: "cancel" },
                {
                  text: gt("Rotate", { $context: "verb, replace the webhook URL" }),
                  style: "destructive",
                  onPress: () => {
                    setRotating(true);
                    void rotate({ environmentId, input: { id: task.id } }).then((result) => {
                      setRotating(false);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        Dialog.alert(
                          gt("Could not rotate URL"),
                          String(squashAtomCommandFailure(result)),
                        );
                      }
                    });
                  },
                },
              ])
            }
            loading={rotating}
          />
        </>
      )}
      {signatureConfigured ? (
        <Text className="text-sm text-foreground-muted">
          <T>Signature check configured on desktop/web.</T>
        </Text>
      ) : null}
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
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const environmentId = environment.environmentId;
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const savedOrder =
    preferences._tag === "Success"
      ? preferences.value.scheduledTaskOrders?.[environmentId]
      : undefined;
  const allTasks = tasks.data?.tasks ?? [];
  const visibleTasks = orderScheduledTasks(allTasks, savedOrder).filter(
    (task) => projectIds === null || projectIds.includes(task.projectId),
  );
  const reorderable = visibleTasks.length > 1 && preferences._tag === "Success";
  const [drag, setDrag] = useState<{ id: ScheduledTaskId; translation: number } | null>(null);
  const [heights, setHeights] = useState<ReadonlyMap<ScheduledTaskId, number>>(() => new Map());
  const move = (from: ScheduledTaskId, to: ScheduledTaskId) => {
    if (from === to) return;
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    void save({
      transform: (current) => {
        const order = moveScheduledTask(
          orderScheduledTasks(allTasks, current.scheduledTaskOrders?.[environmentId]),
          visibleIds,
          from,
          to,
        );
        return order
          ? { scheduledTaskOrders: { ...current.scheduledTaskOrders, [environmentId]: order } }
          : {};
      },
    });
  };
  const dropIndex = (from: number, translation: number) => {
    const step = translation > 0 ? 1 : -1;
    let to = from;
    let remaining = Math.abs(translation);
    while (to + step >= 0 && to + step < visibleTasks.length) {
      const height = heights.get(visibleTasks[to + step]!.id) ?? 0;
      if (height === 0 || remaining < height / 2) break;
      remaining -= height;
      to += step;
    }
    return to;
  };
  const dragFrom = drag === null ? -1 : visibleTasks.findIndex((task) => task.id === drag.id);
  const dragTo = drag && dragFrom >= 0 ? dropIndex(dragFrom, drag.translation) : -1;
  const liftedHeight = drag === null ? 0 : (heights.get(drag.id) ?? 0);
  const rowOffset = (index: number) => {
    if (index === dragFrom) return drag?.translation ?? 0;
    if (dragFrom < index && index <= dragTo) return -liftedHeight;
    if (dragFrom > index && index >= dragTo) return liftedHeight;
    return 0;
  };
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
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
  const selectDetail = useSelectWorkspaceDetail();
  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const act = async (task: ScheduledTask, action: "run" | "toggle" | "delete") => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result =
      action === "run"
        ? await runNow({ environmentId, input: { id: task.id } })
        : action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await remove({ environmentId, input: { id: task.id } });
    failure(
      action === "run"
        ? gt("Could not run task")
        : action === "toggle"
          ? gt("Could not update task")
          : gt("Could not delete task"),
      result,
    );
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
        <Text className="p-4 text-base text-foreground-muted">
          <T>Loading tasks…</T>
        </Text>
      ) : visibleTasks.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {projectIds === null ? gt("No scheduled tasks yet.") : gt("No tasks in this project.")}
        </Text>
      ) : (
        visibleTasks.map((task, index) => (
          <View
            key={task.id}
            onLayout={(event) => {
              const height = event.nativeEvent.layout.height;
              setHeights((current) =>
                current.get(task.id) === height ? current : new Map(current).set(task.id, height),
              );
            }}
            style={
              dragFrom >= 0
                ? {
                    transform: [{ translateY: rowOffset(index) }],
                    zIndex: index === dragFrom ? 1 : 0,
                  }
                : undefined
            }
            className={cn(
              "flex-row items-start gap-1 px-4 py-3",
              index > 0 && "border-t border-border-subtle",
              index === dragFrom && "bg-grouped-card shadow-md",
            )}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Edit {title}", { title: task.title })}
              onPress={() => {
                onEdit(task);
              }}
              className="min-w-0 flex-1 gap-1 active:opacity-70"
            >
              <Text textRole="body" className="text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {!task.enabled
                  ? gt("{schedule} · Paused", {
                      schedule: describeSchedule(task, tasks.data?.timeZone, m, locale),
                    })
                  : task.nextRunAt
                    ? gt("{schedule} · {nextRun}", {
                        schedule: describeSchedule(task, tasks.data?.timeZone, m, locale),
                        nextRun: formatNextScheduledTaskRun(task.nextRunAt, now, m),
                      })
                    : describeSchedule(task, tasks.data?.timeZone, m, locale)}
              </Text>
              {task.blockedByPolicy ? (
                <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                  {task.blockedByPolicy}
                </Text>
              ) : null}
              {task.lastRunError ? (
                <Text className="text-sm text-danger-foreground" numberOfLines={2}>
                  <T>
                    Last run failed: <Var>{task.lastRunError}</Var>
                  </T>
                </Text>
              ) : null}
            </Pressable>
            <Menu
              actions={[
                { id: "edit", title: gt("Edit") },
                ...(task.threadId !== null && scheduledTaskThreadMode(task) !== "new_thread"
                  ? [{ id: "thread", title: gt("Open thread") }]
                  : []),
                {
                  id: "toggle",
                  title: task.enabled ? gt("Pause") : gt("Resume"),
                  attributes: { disabled: !canOperate },
                },
                ...(task.schedule.type === "webhook"
                  ? []
                  : [{ id: "run", title: gt("Run now"), attributes: { disabled: !canOperate } }]),
                {
                  id: "delete",
                  title: gt("Delete"),
                  attributes: { destructive: true, disabled: !canOperate },
                },
              ]}
              onPressAction={({ nativeEvent }) => {
                const action = nativeEvent.event;
                if (action === "edit") {
                  onEdit(task);
                } else if (action === "thread" && task.threadId !== null) {
                  selectDetail({
                    name: "Thread",
                    params: {
                      environmentId: String(environmentId),
                      threadId: String(task.threadId),
                    },
                  });
                } else if (action === "delete") {
                  Dialog.alert(gt("Delete task?"), task.title, [
                    { text: gt("Cancel"), style: "cancel" },
                    {
                      text: gt("Delete"),
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
                accessibilityLabel={gt("Actions for {title}", { title: task.title })}
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
            {reorderable ? (
              <SettingsDragHandle
                title={task.title}
                canMoveUp={index > 0}
                canMoveDown={index + 1 < visibleTasks.length}
                onStart={() => setDrag({ id: task.id, translation: 0 })}
                onMove={(translation) => setDrag({ id: task.id, translation })}
                onEnd={(translation, cancelled) => {
                  setDrag(null);
                  const target = visibleTasks[dropIndex(index, translation)];
                  if (!cancelled && target) move(task.id, target.id);
                }}
                onStep={(direction) => {
                  const target = visibleTasks[index + (direction === "up" ? -1 : 1)];
                  if (target) move(task.id, target.id);
                }}
              />
            ) : null}
          </View>
        ))
      )}
    </SettingsSection>
  );
}

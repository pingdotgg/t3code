import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  managedCapabilityDenial,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import type {
  EnvironmentId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
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
import { usePreparedConnection } from "../../state/session";
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
  editDraft,
  parseIntervalMinutes,
  scheduledTaskDefaultModel,
  scheduleFromDraft,
  type ScheduledTaskDraft as Draft,
} from "./scheduledTaskDraft";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";
import { useScheduledTaskEditor } from "./scheduled-task-editor";
import {
  discardScheduledTaskEditor,
  markScheduledTaskEditorSaved,
  scheduledTaskEditorSessionAtom,
} from "./scheduled-task-editor-state";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";
import { TaskForm } from "./SettingsScheduledTasksRouteScreenParts";
import { EnvironmentTasks } from "./SettingsScheduledTasksRouteScreenParts2";

export type ScheduledTaskRoutes = {
  SettingsScheduledTaskNew: undefined;
  SettingsScheduledTaskEdit: undefined;
  SettingsScheduledTaskModel: undefined;
  SettingsScheduledTaskBranch: undefined;
};

export const DAYS = [
  { index: 1, label: "Mon" },
  { index: 2, label: "Tue" },
  { index: 3, label: "Wed" },
  { index: 4, label: "Thu" },
  { index: 5, label: "Fri" },
  { index: 6, label: "Sat" },
  { index: 0, label: "Sun" },
] as const;

export function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.type === "webhook") return "On webhook";
  if (task.schedule.type === "once") {
    const runAt = new Date(task.schedule.runAt);
    return `Once, ${formatRunAtDate(runAt)} at ${formatRunAtTime(runAt)}`;
  }
  if (task.schedule.type === "interval") return formatScheduledTaskInterval(task.schedule.everyMs);
  const days = task.schedule.weekdays?.length ? repeatLabel(task.schedule.weekdays) : "Every day";
  return `${days} at ${formatTime(task.schedule.timeOfDay)}`;
}

export function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatRunAtDate(value: Date): string {
  return value.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function formatRunAtTime(value: Date): string {
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function timePickerValue(value: string): Date {
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

export function repeatLabel(weekdays: ReadonlyArray<number>): string {
  const days = new Set(weekdays);
  if (days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => day.label)
      .join(", ") || "Choose days"
  );
}

export function FormField(props: {
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

export function SelectRow(props: {
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
        accessibilityLabel={`${props.label}, ${props.value}`}
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

export function WebhookFilterRows(props: {
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  readonly disabled: boolean;
  readonly onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    props.onChange(
      props.filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)),
    );
  return (
    <>
      {props.filters.map((filter, index) => (
        <View key={filter.id}>
          <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 pt-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted">Filter {index + 1}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove filter ${index + 1}`}
              disabled={props.disabled}
              hitSlop={8}
              onPress={() => props.onChange(removeWebhookFilterDraft(props.filters, filter.id))}
              className="active:opacity-70"
            >
              <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
            </Pressable>
          </View>
          <FormField
            label="Path"
            value={filter.path}
            placeholder="body.action"
            disabled={props.disabled}
            onChange={(path) => update(index, { path })}
          />
          <SelectRow
            label="Test"
            value={WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label ?? ""}
            actions={WEBHOOK_FILTER_OPS.map((option) => ({
              id: option.op,
              title: option.label,
              state: option.op === filter.op ? ("on" as const) : undefined,
            }))}
            onSelect={(id) => {
              const known = WEBHOOK_FILTER_OPS.find((option) => option.op === id);
              if (known) update(index, { op: known.op });
            }}
          />
          {filter.op === "exists" ? null : (
            <FormField
              label={filter.op === "in" ? "Values, comma-separated" : "Value"}
              value={filter.value}
              placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
              disabled={props.disabled}
              onChange={(value) => update(index, { value })}
            />
          )}
        </View>
      ))}
      {props.filters.length < MAX_WEBHOOK_FILTERS ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => props.onChange([...props.filters, emptyWebhookFilterDraft()])}
          className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
        >
          <Text textRole="body" className="min-w-0 flex-1 text-foreground">
            Add filter
          </Text>
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      ) : null}
      {props.filters.length > 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          Runs only when every filter matches. Other requests are logged as filtered. Separate “is
          one of” values with commas; a value can't contain a comma.
        </Text>
      ) : null}
    </>
  );
}

export function PickerRow(props: {
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
        title="Scheduled tasks"
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

// The "New task" action and takeScheduledTaskNewLink clear the editor before
// this screen opens, so it starts from the default target.
export function SettingsScheduledTaskNewRouteScreen() {
  return <SettingsScheduledTaskEditorScreen title="New scheduled task" />;
}

export function SettingsScheduledTaskEditRouteScreen() {
  return <SettingsScheduledTaskEditorScreen title="Edit scheduled task" />;
}

function SettingsScheduledTaskEditorScreen({ title }: { readonly title: string }) {
  const { editor, voiceOwnerKey, readEditor, setEditor, hasChanges, draftForEnvironment } =
    useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
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
    subscribeToDraftChanges: (onChange) =>
      appAtomRegistry.subscribe(scheduledTaskEditorSessionAtom, onChange),
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
      Dialog.alert("Saving task", "Wait for the task to finish saving before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
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
            onSaved={() => {
              saved.current = true;
              markScheduledTaskEditorSaved();
              if (navigation.isFocused()) navigation.goBack();
            }}
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

export function WebhookScheduleDetails({
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
  const [rotating, setRotating] = useState(false);
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const webhook = task?.schedule.type === "webhook" ? task.webhook : undefined;
  const resolved = webhook ? webhookAddress(webhook, httpBaseUrl) : null;
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        {
          "The prompt can use {{body.a.b}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}}. The filled-in prompt is all the agent sees."
        }
      </Text>
      {task === null || resolved === null ? (
        <Text className="text-sm text-foreground-muted">Save the task to get its webhook URL.</Text>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy webhook URL"
            accessibilityHint="Copies the URL to the clipboard"
            disabled={!resolved.copyable}
            onPress={() => void tryCopyTextWithHaptic(resolved.address)}
            className="gap-1 active:opacity-70"
          >
            <Text textRole="body" className="text-foreground">
              {resolved.copyable ? "Webhook URL" : "Webhook path"}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={2} selectable>
              {resolved.address}
            </Text>
          </Pressable>
          {resolved.note !== null ? (
            <Text className="text-sm text-foreground-muted">{resolved.note}</Text>
          ) : null}
          <Button
            label={rotating ? "Rotating…" : "Rotate URL"}
            tone="danger"
            disabled={disabled || rotating}
            onPress={() =>
              Dialog.alert("Rotate URL?", "The current URL stops working immediately.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Rotate",
                  style: "destructive",
                  onPress: () => {
                    setRotating(true);
                    void rotate({ environmentId, input: { id: task.id } }).then((result) => {
                      setRotating(false);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        Dialog.alert(
                          "Could not rotate URL",
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
          Signature check configured on desktop/web.
        </Text>
      ) : null}
    </View>
  );
}

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    upsert: vi.fn(),
    alert: vi.fn(),
    tasks: [] as ScheduledTask[],
    timePicker: null as {
      value: Date;
      onValueChange: (event: unknown, selected: Date) => void;
    } | null,
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: Children,
  TextInput: () => null,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: () => false }),
  usePreventRemove: () => {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  DateTimePicker: (props: NonNullable<typeof mocks.timePicker>) => {
    mocks.timePicker = props;
    return null;
  },
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
  ENVIRONMENT_MACHINE_SYMBOLS: {},
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    actions,
    onPressAction,
  }: {
    actions: readonly { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) =>
    actions.map(({ id, title }) => (
      <button key={id} onClick={() => onPressAction({ nativeEvent: { event: id } })}>
        Select {title}
      </button>
    )),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => null,
}));
vi.mock("./components/ScheduledTaskPromptField", () => ({ ScheduledTaskPromptField: () => null }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../../state/threads", () => ({ threadFamilies: {} }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: vi.fn() }));
vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: () => ({ blocksSubmission: false }),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/SegmentedControl", () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: readonly { value: string; label: string }[];
    onSelect: (value: string) => void;
  }) =>
    options.map(({ value, label }) => (
      <button key={value} onClick={() => onSelect(value)}>
        {label}
      </button>
    )),
}));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: ({
    value,
    onValueChange,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => <button onClick={() => onValueChange(!value)}>Toggle enabled</button>,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "environment", id: "project", title: "Project" },
    { environmentId: "target", id: "target-project", title: "Target project" },
  ],
  useServerConfigs: () => new Map(),
  useEnvironmentServerConfig: () => null,
  useThreadShell: () => null,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [{ environmentId: "environment", label: "Environment" }],
    availableTargets: [
      { environmentId: "environment", label: "Environment" },
      { environmentId: "target", label: "Target" },
    ],
    selectedProjectKey: null,
    projectGroups: [],
  }),
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  resolveDefaultableModelSelection: () => null,
  resolveNewTaskModelSelection: () => null,
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => ({}),
    upsertScheduledTask: { permissionAtom: () => Atom.make(true) },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: mocks.tasks, threads: [] } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.upsert }));
vi.mock("../../state/queries", () => ({
  usePaginatedBranches: () => ({ refs: [], data: null, error: null }),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { editDraft } from "./scheduledTaskDraft";
import {
  scheduledTaskEditorSessionAtom,
  startScheduledTaskEditor,
} from "./scheduled-task-editor-state";
import { SettingsScheduledTaskEditRouteScreen } from "./SettingsScheduledTasksRouteScreen";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.alert.mockReset();
  mocks.upsert.mockReset();
  mocks.timePicker = null;
  mocks.upsert.mockResolvedValue({ _tag: "Success" });
  const task: ScheduledTask = {
    id: ScheduledTaskId.make("task"),
    title: "Task",
    prompt: "Prompt",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "05:00" },
    projectId: ProjectId.make("project"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "mobile",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  mocks.tasks = [task];
  const draft = editDraft(task);
  startScheduledTaskEditor({
    environmentId: EnvironmentId.make("environment"),
    environmentLabel: "Environment",
    draft: { ...draft, schedule: { ...draft.schedule, intervalMinutes: "60" } },
  });
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <SettingsScheduledTaskEditRouteScreen />
      </RegistryContext.Provider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, null);
});
function button(label: string) {
  const element = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
describe("scheduled task batched edits", () => {
  it("submits the selected interval when saved before React commits", async () => {
    await act(async () => {
      button("Interval").click();
      button("Save changes").click();
    });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: expect.objectContaining({
        id: "task",
        requireExisting: true,
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
    });
  });
  it("retains the interval when enabled changes before React commits", async () => {
    act(() => {
      button("Interval").click();
      button("Toggle enabled").click();
    });
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current?.draft.schedule.mode).toBe(
      "interval",
    );
    await act(async () => button("Save changes").click());
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: expect.objectContaining({
        id: "task",
        requireExisting: true,
        enabled: false,
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
    });
  });
  it("keeps every webhook filter added before React commits", () => {
    act(() => button("On webhook").click());
    act(() => {
      button("Add filter").click();
      button("Add filter").click();
    });
    expect(
      appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current?.draft.schedule.filters,
    ).toHaveLength(2);
  });
  it("keeps the target project when an old picker fires after changing environments", () => {
    const editor = appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current;
    if (!editor) throw new Error("Missing editor");
    act(() => startScheduledTaskEditor({ ...editor, draft: { ...editor.draft, task: null } }));
    act(() => {
      button("Select Target").click();
      button("Interval").click();
      button("Select Project").click();
    });
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toMatchObject({
      environmentId: "target",
      draft: { projectId: "target-project", schedule: { mode: "interval" } },
    });
  });
  it("keeps a fixed time on a DST spring-forward day in the phone's zone", () => {
    const editor = appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current;
    if (!editor) throw new Error("Missing editor");
    const previousZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"] });
    // 02:00 to 02:59 does not exist in New York on this day.
    vi.setSystemTime(new Date("2026-03-08T12:00:00-04:00"));
    try {
      act(() =>
        startScheduledTaskEditor({
          ...editor,
          draft: { ...editor.draft, schedule: { ...editor.draft.schedule, timeOfDay: "02:30" } },
        }),
      );
      const timeRow = Array.from(container.querySelectorAll("button")).find((element) =>
        element.textContent?.startsWith("Time"),
      );
      if (!timeRow) throw new Error("Missing time row");
      const label = timeRow.textContent;
      act(() => timeRow.click());
      const picker = mocks.timePicker;
      if (!picker) throw new Error("Missing time picker");
      // Native pickers keep the value's date and set the chosen local hour and minute.
      const picked = new Date(picker.value);
      picked.setHours(2, 30);
      act(() => picker.onValueChange({}, picked));
      expect({
        label,
        pickerTime: [picker.value.getHours(), picker.value.getMinutes()],
        saved: appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current?.draft.schedule
          .timeOfDay,
      }).toEqual({
        label: `Time${new Date(Date.UTC(2000, 0, 1, 2, 30)).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "UTC",
        })}`,
        pickerTime: [2, 30],
        saved: "02:30",
      });
    } finally {
      vi.useRealTimers();
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });
});

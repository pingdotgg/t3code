import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { resolveHour12 } from "../../timestampFormat";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};
const fixedTask: ScheduledTask = {
  ...task,
  schedule: { type: "fixed_time", timeOfDay: "17:30" },
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [{ id: task.threadId, title: "Fix login bug" }],
};

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  secondary: false,
  fixed: false,
}));
const settingsAtom = Atom.make(DEFAULT_UNIFIED_SETTINGS);
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.secondary = false;
  state.fixed = false;
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function secondaryEnvironment() {
  return { ...environment(), environmentId: secondaryId, label: "Secondary" };
}

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? { environment: { platform: "linux", capabilities: { oneTimeSchedules: true } } }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: state.secondary ? [entry, secondaryEnvironment()] : [entry],
      connectedEnvironments: state.connected
        ? state.secondary
          ? [entry, secondaryEnvironment()]
          : [entry]
        : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
    },
  };
});
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead
        ? request
        : {
            tasks: state.tasksLoaded ? [state.fixed ? fixedTask : task] : [],
          },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) =>
    id === secondaryId ? secondaryEnvironment() : environment()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => useAtomValue(settingsAtom)) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("honors time format while preserving the fixed time through noon and midnight", async () => {
    setup();
    state.fixed = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(settingsAtom, { ...DEFAULT_UNIFIED_SETTINGS, timestampFormat: "24-hour" });
    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings taskId={task.id} />
      </RegistryContext.Provider>,
    );
    const setFormat = (timestampFormat: TimestampFormat) =>
      act(() => registry.set(settingsAtom, { ...DEFAULT_UNIFIED_SETTINGS, timestampFormat }));
    const hours = page.getByRole("combobox", { name: "Run at hours", exact: true });
    const minutes = page.getByRole("combobox", { name: "Run at minutes", exact: true });
    const period = page.getByRole("combobox", { name: "Run at period", exact: true });
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(hours).toHaveTextContent("17");
    await expect.element(minutes).toHaveTextContent("30");
    await expect.element(period).not.toBeInTheDocument();

    await setFormat("12-hour");
    await expect.element(hours).toHaveTextContent("05");
    await expect.element(period).toHaveTextContent("PM");
    await hours.click();
    await page.getByRole("option", { name: "12", exact: true }).click();
    await minutes.click();
    await page.getByRole("option", { name: "00", exact: true }).click();

    await setFormat("24-hour");
    await expect.element(hours).toHaveTextContent("12");
    await expect.element(minutes).toHaveTextContent("00");

    await setFormat("12-hour");
    await period.click();
    await page.getByRole("option", { name: "AM", exact: true }).click();
    await setFormat("24-hour");
    await expect.element(hours).toHaveTextContent("00");
    await expect.element(minutes).toHaveTextContent("00");

    await setFormat("locale");
    await expect.element(hours).toHaveTextContent(resolveHour12("locale") ? "12" : "00");
    if (resolveHour12("locale")) {
      await expect.element(period).toHaveTextContent("AM");
    } else {
      await expect.element(period).not.toBeInTheDocument();
    }

    await setFormat("24-hour");
    await hours.click();
    await page.getByRole("option", { name: "23", exact: true }).click();
    await minutes.click();
    await page.getByRole("option", { name: "59", exact: true }).click();
    await setFormat("12-hour");
    await expect.element(hours).toHaveTextContent("11");
    await expect.element(minutes).toHaveTextContent("59");
    await expect.element(period).toHaveTextContent("PM");
  });

  it("creates on a permitted secondary and reacts to permission changes", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(permissions.get(environmentId)!, false);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = screen.getByRole("button", { name: "New task" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(secondaryId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(secondaryId)!, true));
    await expect.element(create).toBeEnabled();
    await create.click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Secondary");
  });

  it("keeps the permitted representative as the creation target", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New task" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Laptop");
  });

  it("disables creation without a connected target", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByRole("button", { name: "New task" })).toBeDisabled();
  });

  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(dialog.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });
});

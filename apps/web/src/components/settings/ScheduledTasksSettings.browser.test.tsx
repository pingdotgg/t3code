import { RegistryContext } from "@effect/atom-react";
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
import { ConfirmDialogHost } from "../ConfirmDialogHost";

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

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [
    {
      id: task.threadId,
      title: "Fix login bug",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    },
  ],
};

const archivedTask: ScheduledTask = {
  ...task,
  id: ScheduledTaskId.make("stale"),
  title: "Stale sweep",
  enabled: false,
  archivedAt: "2026-11-01T12:00:00.000Z",
  archiveReason: "paused",
};

const agentTask: ScheduledTask = {
  ...task,
  id: ScheduledTaskId.make("agent-task"),
  title: "Morning pull",
  profileId: "reviewer",
  threadId: ThreadId.make("agent-thread"),
  threadMode: "continue",
  schedule: { type: "cron", expression: "30 8 * * 1-5", timezone: "Europe/London" },
};

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  secondary: false,
  archived: false,
  agent: false,
  commands: [] as unknown[],
}));
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.secondary = false;
  state.archived = false;
  state.agent = false;
  state.commands = [];
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function secondaryEnvironment() {
  return { ...environment(), environmentId: secondaryId, label: "Secondary" };
}

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

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
            tasks: state.tasksLoaded
              ? [
                  task,
                  ...(state.archived ? [archivedTask] : []),
                  ...(state.agent ? [agentTask] : []),
                ]
              : [],
          },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async (value: unknown) => {
    state.commands.push(value);
    return { _tag: "Success", value: undefined };
  }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) =>
    id === secondaryId ? secondaryEnvironment() : environment()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
  useQuietThreadShell: ((ref: { threadId: ThreadId } | null) =>
    ref && { environmentId, id: ref.threadId, projectId, title: "Fix login bug" }) as never,
}));
vi.mock(import("~/hooks/useAgentLibrary"), async (original) => ({
  ...(await original()),
  useAgentLibrary: (() => ({
    profiles: [{ profileId: "reviewer", name: "Reviewer", runtimeMode: "full-access" }],
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("only deletes a scheduled task after confirmation, including after cancelling", async () => {
    setup();
    await using screen = await render(
      <>
        <ScheduledTasksSettings />
        <ConfirmDialogHost />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Actions for Review issues" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete", exact: true }));
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(state.commands).toEqual([]);
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(state.commands).toEqual([]);
    await expect
      .element(screen.getByRole("button", { name: "Actions for Review issues" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Review issues" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Confirm", exact: true }));
    await vi.waitFor(() =>
      expect(state.commands).toEqual([{ environmentId, input: { id: task.id } }]),
    );
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

  it("lists an archived task only under Archived and restores it", async () => {
    setup();
    state.archived = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByText("Review issues")).toBeVisible();
    await expect.element(screen.getByText("Stale sweep")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: /^Archived/ }).click();
    await expect.element(screen.getByText("Stale sweep")).toBeVisible();
    await expect.element(screen.getByText("Review issues")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText(/Archived: paused for 10 days · Deletes on/))
      .toBeVisible();

    await screen.getByRole("button", { name: "Restore" }).click();
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        { environmentId, input: { id: archivedTask.id, enabled: true } },
      ]),
    );
  });

  it("filters by target and edits an agent task's agent and cron schedule", async () => {
    setup();
    state.agent = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "Agents" }).click();
    await expect.element(screen.getByText("Morning pull")).toBeVisible();
    await expect.element(screen.getByText("Review issues")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Actions for Morning pull" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByLabelText("Agent")).toHaveTextContent("Reviewer");
    await expect.element(dialog.getByLabelText("Repeat")).toHaveTextContent("Weekdays");
    await userEvent.fill(dialog.getByLabelText("Time", { exact: true }), "09:15");
    await userEvent.fill(dialog.getByLabelText("Time zone"), "Asia/Tokyo");
    await dialog.getByRole("button", { name: "Save task" }).click();
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        {
          environmentId,
          input: expect.objectContaining({
            id: agentTask.id,
            profileId: "reviewer",
            threadId: agentTask.threadId,
            schedule: { type: "cron", expression: "15 9 * * 1-5", timezone: "Asia/Tokyo" },
          }),
        },
      ]),
    );
  });

  it("opens a new task bound to the linked thread", async () => {
    setup();
    await using _screen = await render(
      <ScheduledTasksSettings environmentId={environmentId} threadId={task.threadId!} />,
    );
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    await expect.element(dialog.getByText("Fix login bug")).toBeVisible();
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

  it("offers no model choice for a task bound to a thread, whose runs use the thread's model", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const enabledPicker = document.querySelector(
      '[role="dialog"] [data-chat-provider-model-picker]:not(:disabled)',
    );
    expect(enabledPicker).toBeNull();
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "gpt-5.5", exact: true }))
      .toBeDisabled();
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

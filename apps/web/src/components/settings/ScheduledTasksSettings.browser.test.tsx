import { RegistryContext } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type UnifiedSettings,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { initializeI18n } from "~/i18n/initializeI18n";
import { createModelCapabilities } from "@t3tools/shared/model";
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

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  remove: vi.fn(),
  tasks: [] as ScheduledTask[],
  secondary: false,
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  upsert: vi.fn(),
  monthDays: true,
}));
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();
type TaskList = { readonly tasks: ReadonlyArray<ScheduledTask>; readonly timeZone: string };
// The list each machine streams when several are in scope; unset machines are still loading.
const taskLists = new Map<string, Atom.Writable<AsyncResult.AsyncResult<TaskList>>>();
function taskList(id: string) {
  const existing = taskLists.get(id);
  if (existing) return existing;
  const created = Atom.make<AsyncResult.AsyncResult<TaskList>>(AsyncResult.initial());
  taskLists.set(id, created);
  return created;
}

function setup() {
  // GTProvider leaves its locale in a cookie; this sets it back to English.
  initializeI18n(() => {});
  state.connected = true;
  state.tasksLoaded = true;
  state.remove.mockReset().mockReturnValue(Effect.succeed({ id: task.id }));
  state.tasks = [task];
  state.secondary = false;
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([]);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.upsert.mockReset().mockReturnValue(Effect.succeed({ id: task.id }));
  state.monthDays = true;
  permissions.clear();
  taskLists.clear();
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
    entry: { target: { _tag: "PrimaryConnectionTarget" } },
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? {
          environment: {
            platform: "linux",
            capabilities: { oneTimeSchedules: true, scheduledTaskMonthDays: state.monthDays },
          },
        }
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
      deleteScheduledTask: {
        ...actual.serverEnvironment.deleteScheduledTask,
        run: state.remove,
      },
      providersValueAtom: (() => state.providers) as never,
      scheduledTasksLive: (({ environmentId }: { environmentId: string }) =>
        taskList(environmentId)) as never,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        run: state.upsert,
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
        : { tasks: state.tasksLoaded ? state.tasks : [] },
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
  useEnvironmentSettings: (() => state.settings) as never,
}));

function setupEffortTask() {
  setup();
  const selection = {
    ...task.modelSelection,
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  state.tasks = [{ ...task, threadId: null, modelSelection: selection }];
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, defaultModelSelection: selection };
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([
    {
      instanceId: selection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-03T00:00:00.000Z",
      models: [
        {
          slug: selection.model,
          name: "GPT-5.4",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                options: [
                  { id: "low", label: "Low", isDefault: true },
                  { id: "high", label: "High" },
                ],
                currentValue: "low",
              },
            ],
          }),
        },
        { slug: "plain", name: "Plain model", isCustom: false, capabilities: null },
        { slug: "gpt-5.5", name: "Bound model", isCustom: false, capabilities: null },
      ],
      skills: [],
      slashCommands: [],
    },
  ]);
  return selection;
}

async function fillTitleAndPrompt() {
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Effort task");
  await userEvent.fill(page.getByRole("textbox", { name: "Prompt", exact: true }), "Review issues");
}

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
    expect(state.remove).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(state.remove).not.toHaveBeenCalled();
    await expect
      .element(screen.getByRole("button", { name: "Actions for Review issues" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Review issues" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Confirm", exact: true }));
    await vi.waitFor(() =>
      expect(state.remove).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        environmentId,
        input: { id: task.id },
      }),
    );
  });

  it.each([false, true])(
    "keeps model options when the same model is reselected (existing task: %s)",
    async (editing) => {
      const selection = setupEffortTask();
      await using screen = await render(
        <ScheduledTasksSettings {...(editing ? { taskId: task.id } : {})} />,
      );
      if (!editing) {
        await screen.getByRole("button", { name: "New task" }).click();
        await page.getByRole("combobox", { name: "Workspace" }).click();
        await page.getByRole("option", { name: "Use the project checkout" }).click();
      }
      await fillTitleAndPrompt();
      await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
      await page.getByRole("option", { name: /GPT-5.4/ }).click();
      await expect.element(page.getByRole("button", { name: "High", exact: true })).toBeVisible();
      await page.getByRole("button", { name: editing ? "Save task" : "Create task" }).click();
      await vi.waitFor(() =>
        expect(state.upsert).toHaveBeenLastCalledWith(expect.anything(), {
          environmentId,
          input: expect.objectContaining({ modelSelection: selection }),
        }),
      );
    },
  );

  it("saves a changed effort and drops options when switching models", async () => {
    const selection = setupEffortTask();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await fillTitleAndPrompt();
    await page.getByRole("button", { name: "High", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^Low/ }).click();
    await expect.element(page.getByRole("button", { name: "Low", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save task" }).click();
    await vi.waitFor(() =>
      expect(state.upsert).toHaveBeenLastCalledWith(expect.anything(), {
        environmentId,
        input: expect.objectContaining({
          modelSelection: {
            ...selection,
            options: expect.arrayContaining([{ id: "reasoningEffort", value: "low" }]),
          },
        }),
      }),
    );

    await screen.rerender(<ScheduledTasksSettings />);
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
    await page.getByRole("option", { name: /Plain model/ }).click();
    expect(page.getByRole("button", { name: "High", exact: true }).query()).toBeNull();
    await page.getByRole("button", { name: "Save task" }).click();
    await vi.waitFor(() =>
      expect(state.upsert).toHaveBeenLastCalledWith(expect.anything(), {
        environmentId,
        input: expect.objectContaining({
          modelSelection: { instanceId: selection.instanceId, model: "plain" },
        }),
      }),
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

  it("waits for every machine before saying there are no tasks", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(taskList(secondaryId), AsyncResult.success({ tasks: [], timeZone: "UTC" }));
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    await expect
      .element(screen.getByRole("status", { name: "Loading scheduled tasks…" }))
      .toBeVisible();
    await expect.element(screen.getByText("No scheduled tasks")).not.toBeInTheDocument();

    await act(() =>
      registry.set(
        taskList(environmentId),
        AsyncResult.success({ tasks: [task], timeZone: "UTC" }),
      ),
    );
    await expect.element(screen.getByText("Review issues")).toBeVisible();
    await expect.element(screen.getByText("No scheduled tasks")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("status", { name: "Loading scheduled tasks…" }))
      .not.toBeInTheDocument();
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

  it("offers no model choice for a task bound to a thread, whose runs use the thread's model", async () => {
    setupEffortTask();
    state.tasks = [{ ...state.tasks[0]!, threadId: task.threadId }];
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const enabledPicker = document.querySelector(
      '[role="dialog"] [data-chat-provider-model-picker]:not(:disabled)',
    );
    expect(enabledPicker).toBeNull();
    expect(page.getByRole("button", { name: "High", exact: true }).query()).toBeNull();
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Bound model", exact: true }))
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

  it.each([
    { locale: "en", one: "minute", other: "minutes" },
    { locale: "de", one: "Minute", other: "Minuten" },
  ])(
    "labels intervals of 1, 15 and 1.5 as $one or $other in $locale",
    async ({ locale, one, other }) => {
      setup();
      const translations = await getTranslationsSnapshot(locale);
      await using _screen = await render(
        <GTProvider locale={locale} translations={translations}>
          <ScheduledTasksSettings taskId={task.id} />
        </GTProvider>,
      );
      const interval = page.elementLocator(document.getElementById("scheduled-task-interval")!);
      const unit = () =>
        document.getElementById("scheduled-task-interval")?.parentElement?.nextElementSibling;

      await expect.element(interval).toHaveValue(1);
      expect(unit()?.textContent).toBe(one);
      await userEvent.fill(interval, "15");
      await expect.poll(() => unit()?.textContent).toBe(other);
      await userEvent.fill(interval, "1.5");
      await expect.poll(() => unit()?.textContent).toBe(other);
    },
  );

  it("names the Delete action in the UI language", async () => {
    setup();
    const translations = await getTranslationsSnapshot("de");
    await using screen = await render(
      <GTProvider locale="de" translations={translations}>
        <ScheduledTasksSettings />
      </GTProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Aktionen für Review issues" }));

    await expect
      .element(page.getByRole("menuitem", { name: "Löschen", exact: true }))
      .toBeVisible();
  });

  it("keeps a new task's draft when the user clicks outside the editor", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    await userEvent.click(document.body, { position: { x: 1, y: 1 } });

    await expect.element(dialog).toHaveAttribute("data-open");
    await expect.element(name).toHaveValue("My draft");
  });

  it("offers days of the month only when the server can store them", async () => {
    setup();
    const monthDaysToggle = async (monthDays: boolean) => {
      state.monthDays = monthDays;
      await using _screen = await render(<ScheduledTasksSettings />);
      await userEvent.click(page.getByRole("button", { name: "New task" }));
      const dialog = page.getByRole("dialog");
      await expect.element(dialog.getByRole("button", { name: "Mon" })).toBeInTheDocument();
      return dialog.getByRole("button", { name: "Days of the month" }).query() !== null;
    };
    expect(await monthDaysToggle(false)).toBe(false);
    expect(await monthDaysToggle(true)).toBe(true);
  });
});

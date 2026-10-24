import { RegistryContext } from "@effect/atom-react";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskListResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  tasks: null as unknown as Atom.Writable<AsyncResult.AsyncResult<ScheduledTaskListResult>>,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      scheduledTasksLive: (() => state.tasks) as never,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: () => allowed,
      },
      deleteScheduledTask: {
        ...actual.serverEnvironment.deleteScheduledTask,
        run: async (registry, { input }) => {
          const current = registry.get(state.tasks);
          if (current._tag !== "Success") throw new Error("Missing task list");
          registry.set(
            state.tasks,
            AsyncResult.success({
              tasks: current.value.tasks.filter((task) => task.id !== input.id),
            }),
          );
          return AsyncResult.success({ id: input.id });
        },
      },
    },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Local environment",
      connection: { phase: "connected" },
      serverConfig: { environment: { platform: "linux" } },
    };
    return {
      scope: { kind: "all", environmentIds: ["env"] },
      environments: [environment],
      connectedEnvironments: [environment],
      environment,
    };
  }) as never,
}));
// Rows otherwise subscribe to unrelated settings write permissions and overrides.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingsRow: ({ title, control }: { title: ReactNode; control?: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
}));

import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

function setup(tasks: ScheduledTaskListResult["tasks"]) {
  state.tasks = Atom.make<AsyncResult.AsyncResult<ScheduledTaskListResult>>(
    AsyncResult.success({ tasks }),
  );
}

const task: ScheduledTask = {
  id: ScheduledTaskId.make("task"),
  title: "Daily summary",
  prompt: "Summarize the project",
  enabled: false,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "example" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

it("keeps a scheduled task until deletion is confirmed, including after cancelling", async () => {
  setup([task]);
  using resources = new DisposableStack();
  const registry = AtomRegistry.make();
  resources.defer(() => registry.dispose());
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ScheduledTasksSettings />
      <ConfirmDialogHost />
    </RegistryContext.Provider>,
  );

  await screen.getByRole("button", { name: "Actions for Daily summary" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  expect(registry.get(state.tasks)).toMatchObject({ value: { tasks: [task] } });
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(registry.get(state.tasks)).toMatchObject({ value: { tasks: [task] } });

  await screen.getByRole("button", { name: "Actions for Daily summary" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.element(screen.getByText("No scheduled tasks", { exact: true })).toBeVisible();
  expect(registry.get(state.tasks)).toMatchObject({ value: { tasks: [] } });
});

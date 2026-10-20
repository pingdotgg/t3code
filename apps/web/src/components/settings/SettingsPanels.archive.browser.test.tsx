import { EnvironmentId, OrchestrationV2ArchivedShellSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  unarchiveThread: vi.fn(),
  unarchiveThreads: vi.fn(),
  confirmAndDeleteThread: vi.fn(),
  deleteArchivedThreads: vi.fn(),
  confirm: vi.fn(),
  showContextMenu: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useThreadActions: (() => ({
    unarchiveThread: state.unarchiveThread,
    unarchiveThreads: state.unarchiveThreads,
    confirmAndDeleteThread: state.confirmAndDeleteThread,
    deleteArchivedThreads: state.deleteArchivedThreads,
  })) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [environmentId] },
    groups: [],
    environments: [],
  })) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: () => ({
    snapshots: [{ environmentId, snapshot }],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({
    dialogs: { confirm: state.confirm },
    contextMenu: { show: state.showContextMenu },
  })) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
vi.mock(import("../ProjectFavicon"), async (original) => ({
  ...(await original()),
  ProjectFavicon: () => <span />,
}));
vi.mock(import("./settingsLayout"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    SettingsPageContainer: ({ children }: ComponentProps<typeof actual.SettingsPageContainer>) => (
      <div>{children}</div>
    ),
    SettingsRow: ({ title, control, onContextMenu }: ComponentProps<typeof actual.SettingsRow>) => (
      <div data-slot="settings-row" onContextMenu={onContextMenu}>
        <span>{title}</span>
        {control}
      </div>
    ),
  };
});

import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ArchivedThreadsPanel } from "./SettingsPanels";

const environmentId = EnvironmentId.make("local");
const now = "2026-10-20T06:00:00.000Z";
const snapshot = Schema.decodeUnknownSync(OrchestrationV2ArchivedShellSnapshot)({
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [
    {
      id: "project-1",
      title: "Project",
      workspaceRoot: "/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  ],
  threads: [1, 2].map((index) => ({
    ...makeThreadProjectionFixture().thread,
    id: `thread-${index}`,
    projectId: "project-1",
    title: `Thread ${index}`,
    latestRunId: null,
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    archivedAt: DateTime.makeUnsafe(now),
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  })),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  state.unarchiveThread.mockResolvedValue(AsyncResult.success(undefined));
  state.confirmAndDeleteThread.mockResolvedValue(AsyncResult.success(undefined));
  state.unarchiveThreads.mockResolvedValue(null);
  state.deleteArchivedThreads.mockResolvedValue(null);
  state.confirm.mockResolvedValue(true);
  state.showContextMenu.mockResolvedValue("unarchive");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ArchivedThreadsPanel />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function runBulkAction(label: string) {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Archived thread actions for Project"]')!
      .click();
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
}

function openContextMenu() {
  container
    .querySelector('[data-slot="settings-row"]')!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

it.each([
  ["Unarchive all in project", "unarchiveThreads"],
  ["Delete all in project", "deleteArchivedThreads"],
] as const)(
  "blocks context-menu actions during %s and releases them afterward",
  async (label, method) => {
    const batch = deferred<null>();
    state[method].mockReturnValueOnce(batch.promise);

    await runBulkAction(label);
    expect(state[method]).toHaveBeenCalledOnce();
    await act(async () => openContextMenu());
    expect(state.showContextMenu).not.toHaveBeenCalled();
    expect(state.unarchiveThread).not.toHaveBeenCalled();
    expect(state.confirmAndDeleteThread).not.toHaveBeenCalled();

    await act(async () => batch.resolve(null));
    await act(async () => openContextMenu());
    expect(state.unarchiveThread).toHaveBeenCalledOnce();
  },
);

it.each(["unarchive", "delete"])(
  "rejects %s from a menu opened before a bulk action",
  async (choice) => {
    const menu = deferred<string>();
    const batch = deferred<null>();
    state.showContextMenu.mockReturnValueOnce(menu.promise);
    state.unarchiveThreads.mockReturnValueOnce(batch.promise);

    await act(async () => openContextMenu());
    expect(state.showContextMenu).toHaveBeenCalledOnce();
    await runBulkAction("Unarchive all in project");
    await act(async () => menu.resolve(choice));
    expect(state.unarchiveThread).not.toHaveBeenCalled();
    expect(state.confirmAndDeleteThread).not.toHaveBeenCalled();
    await act(async () => batch.resolve(null));
  },
);

it("locks while confirming bulk deletion and releases the lock on cancellation", async () => {
  const confirmation = deferred<boolean>();
  state.confirm.mockReturnValueOnce(confirmation.promise);

  await runBulkAction("Delete all in project");
  await act(async () => openContextMenu());
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(state.showContextMenu).not.toHaveBeenCalled();
  expect(state.deleteArchivedThreads).not.toHaveBeenCalled();

  await act(async () => confirmation.resolve(false));
  await act(async () => openContextMenu());
  expect(state.unarchiveThread).toHaveBeenCalledOnce();
  expect(state.deleteArchivedThreads).not.toHaveBeenCalled();
});

it("releases the lock and reports a failed bulk action", async () => {
  state.unarchiveThreads.mockRejectedValueOnce(new Error("Disconnected"));

  await runBulkAction("Unarchive all in project");
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Failed to unarchive threads",
      description: "Disconnected",
    }),
  );
  await act(async () => openContextMenu());
  expect(state.unarchiveThread).toHaveBeenCalledOnce();
});

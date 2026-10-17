import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  effects: [] as string[],
  completed: deferred<void>(),
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
  vcsKind: "git" as "git" | "jj",
  copyOptions: [] as {
    target?: string;
    onCopy?: (value: { branch: string }) => void;
    onError?: (error: Error) => void;
  }[],
  toasts: [] as { title: string }[],
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title: string }) => {
      state.toasts.push(toast);
      state.completed.resolve();
    },
  },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: (options: (typeof state.copyOptions)[number]) => {
    state.copyOptions.push(options);
    return { copyToClipboard: () => recordEffect("copy") };
  },
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async () => {
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));
vi.mock("../state/vcs", () => ({
  useVcsTerminology: () => (state.vcsKind === "jj" ? JJ_VCS_TERMINOLOGY : GIT_VCS_TERMINOLOGY),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = () =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
  });

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.completed = deferred<void>();
  state.show.mockReset().mockResolvedValue(null);
  state.vcsKind = "git";
  state.copyOptions = [];
  state.toasts = [];
});

describe("thread menu permissions", () => {
  it("disables mutations for a denied secondary environment", () => {
    createMenu().openMenu(position);
    const items = state.show.mock.calls[0]![0];
    expect(items.find((item) => item.id === "rename")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "copy")?.disabled).not.toBe(true);
  });

  it("allows the target grant even when the primary environment is denied", () => {
    state.granted = new Set(["secondary"]);
    createMenu().openMenu(position);
    expect(state.show.mock.calls[0]![0].find((item) => item.id === "rename")?.disabled).not.toBe(
      true,
    );
  });

  it("refreshes availability when a retained menu opener gains permission", () => {
    const menu = createMenu();
    menu.openMenu(position);
    expect(state.show.mock.calls[0]![0].find((item) => item.id === "rename")?.disabled).toBe(true);
    state.granted.add("secondary");
    menu.openMenu(position);
    expect(state.show.mock.calls[1]![0].find((item) => item.id === "rename")?.disabled).not.toBe(
      true,
    );
  });

  it.each(["rename", "regenerate-title", "delete", "pin", "settle", "archive"] as const)(
    "%s rechecks after the native menu closes",
    async (action) => {
      state.granted.add("secondary");
      const choice = deferred<ThreadActionMenuId | null>();
      state.show.mockReturnValue(choice.promise);
      createMenu().openMenu(position);
      state.granted.delete("secondary");
      choice.resolve(action);
      await state.completed.promise;
      expect(state.effects).toEqual([]);
    },
  );

  it.each([
    ["new-thread-on-branch", "draft"],
    ["copy-thread-id", "copy"],
    ["mark-unread", "mark-unread"],
    ["project-settings", "project-settings"],
  ] as const)("keeps %s available without task permission", async (action, effect) => {
    state.show.mockResolvedValue(action);
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(state.effects).toEqual([effect]);
  });

  it.each([
    ["git", "branch", "Branch"],
    ["jj", "bookmark", "Bookmark"],
  ] as const)("uses %s ref terms in header copy menus and feedback", (kind, noun, title) => {
    state.vcsKind = kind;
    createMenu().openMenu(position);
    const copyMenu = state.show.mock.calls[0]![0].find((item) => item.id === "copy");
    expect(copyMenu?.children?.find((item) => item.id === "copy-branch")?.label).toBe(title);
    const options = state.copyOptions.find((option) => option.target === `${noun} name`);
    expect(options).toBeDefined();
    options?.onCopy?.({ branch: "main" });
    expect(state.toasts.at(-1)?.title).toBe(`${title} copied`);
    options?.onError?.(new Error("Copy failed"));
    expect(state.toasts.at(-1)?.title).toBe(`Failed to copy ${noun}`);
  });
});

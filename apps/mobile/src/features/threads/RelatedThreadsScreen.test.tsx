import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RelatedThreadsScreen } from "./RelatedThreadsScreen";
import type { CompactThreadRow } from "./compact-thread-row";
import type { MobileThreadShell, MobileThreadTreeRow } from "./mobile-thread-hierarchy";
import type { ThreadSwipeable } from "../home/thread-swipe-actions";

const harness = vi.hoisted(() => ({
  threads: [] as MobileThreadShell[],
  rows: [] as ComponentProps<typeof CompactThreadRow>[],
  swipes: [] as ComponentProps<typeof ThreadSwipeable>[],
  legacy: [] as string[],
  v2: true,
  capabilities: {
    threadSettlement: true,
    threadSnooze: true,
    threadPinning: true,
    threadPinReorder: true,
    threadTitleRegeneration: true,
  },
  actions: {
    archiveThread: vi.fn(),
    confirmDeleteThread: vi.fn(),
    regenerateThreadTitle: vi.fn(),
    settleThread: vi.fn(),
    unsettleThread: vi.fn(),
    snoozeThread: vi.fn(),
    unsnoozeThread: vi.fn(),
    pinThread: vi.fn(),
    unpinThread: vi.fn(),
    movePinnedThread: vi.fn(),
  },
  markRead: vi.fn(),
  openParent: vi.fn(),
  dismissAgentRun: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: () => {},
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Pressable: ({ children }: { children: ReactNode }) => createElement("button", null, children),
  useWindowDimensions: () => ({ width: 402 }),
  FlatList: (props: {
    data: MobileThreadTreeRow[];
    renderItem: (input: { item: MobileThreadTreeRow; index: number }) => ReactNode;
  }) =>
    createElement(
      "div",
      null,
      props.data.map((item, index) =>
        createElement("section", { key: item.threadKey }, props.renderItem({ item, index })),
      ),
    ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => harness.threads,
  useServerConfigs: () =>
    new Map([
      [EnvironmentId.make("local"), { environment: { capabilities: harness.capabilities } }],
    ]),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("./thread-hierarchy-controls", () => ({
  useDismissedAgentRunKeys: () => [],
  useThreadCompletionReadAt: () => ({}),
  useMarkThreadGroupNotificationsRead: (rows: MobileThreadTreeRow[]) => harness.markRead(rows),
}));
vi.mock("./use-thread-list-v2-enabled", () => ({ useThreadListV2Enabled: () => harness.v2 }));
vi.mock("../home/useThreadListActions", () => ({ useThreadListActions: () => harness.actions }));
vi.mock("./use-nested-thread-actions", () => ({
  useNestedThreadActions: () => ({
    actions: [],
    handleAction: () => {},
    openParent: harness.openParent,
    dismissAgentRun: harness.dismissAgentRun,
  }),
}));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("./thread-list-items", () => ({
  ThreadListRow: (props: { thread: MobileThreadShell }) => {
    harness.legacy.push(props.thread.title);
    return null;
  },
}));
vi.mock("./compact-thread-row", () => ({
  CompactThreadRow: (props: ComponentProps<typeof CompactThreadRow>) => {
    harness.rows.push(props);
    return null;
  },
}));
vi.mock("../home/thread-swipe-actions", () => ({
  ThreadSwipeable: (props: ComponentProps<typeof ThreadSwipeable>) => {
    harness.swipes.push(props);
    return props.children(() => {});
  },
}));

const parent: MobileThreadShell = {
  environmentId: EnvironmentId.make("local"),
  id: ThreadId.make("parent"),
  projectId: ProjectId.make("project"),
  title: "Parent",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:00.000Z",
  archivedAt: null,
  session: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasPendingQueuedTurn: false,
  hasActionableProposedPlan: false,
};
const child = { ...parent, id: ThreadId.make("child"), title: "Child", parentThreadId: parent.id };
function render(threadId = parent.id) {
  renderToStaticMarkup(
    <RelatedThreadsScreen route={{ params: { environmentId: "local", threadId } }} />,
  );
}
function titles(index = 0) {
  return harness.rows[index]?.menu?.actions.map((action) => action.title);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T20:00:00.000Z"));
  harness.threads = [parent, child];
  harness.rows.length = 0;
  harness.swipes.length = 0;
  harness.legacy.length = 0;
  harness.v2 = true;
  for (const key of Object.keys(harness.capabilities) as Array<keyof typeof harness.capabilities>) {
    harness.capabilities[key] = true;
  }
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("related screen lifecycle parity", () => {
  it("keeps V2 root menus and swipe actions while descendants retain archive", () => {
    render();
    expect(titles()).toEqual(
      expect.arrayContaining(["Settle", "Snooze", "Pin", "Regenerate title"]),
    );
    expect(titles(1)).toEqual(["Archive", "Delete"]);
    expect(harness.rows.every((row) => row.related === undefined)).toBe(true);
    // Active roots render full-strength; only shelf (settled/snoozed) rows fade.
    expect(harness.rows.every((row) => row.muted !== true)).toBe(true);
    expect(harness.rows.map((row) => row.depth)).toEqual([0, 1]);
    harness.swipes[0]?.primaryAction?.onPress();
    expect(harness.actions.settleThread).toHaveBeenCalledWith(parent);
    harness.swipes[1]?.primaryAction?.onPress();
    expect(harness.actions.archiveThread).toHaveBeenCalledWith(child);
    expect(harness.markRead).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ threadKey: "local:parent" }),
        expect.objectContaining({ threadKey: "local:child" }),
      ]),
    );
  });

  it.each([
    {
      patch: { settledOverride: "settled", settledAt: "2026-09-06T19:00:00.000Z" },
      title: "Un-settle",
      action: "unsettleThread",
    },
    {
      patch: { snoozedUntil: "2026-09-06T21:00:00.000Z" },
      title: "Wake thread",
      action: "unsnoozeThread",
    },
  ] as const)("preserves $title on the root", ({ patch, title, action }) => {
    const root = { ...parent, ...patch };
    harness.threads = [root, child];
    render();
    expect(titles()).toContain(title);
    // Shelf roots render faded like the inbox slim rows; the child row stays full.
    expect(harness.rows[0]?.muted).toBe(true);
    expect(harness.rows[1]?.muted).not.toBe(true);
    harness.swipes[0]?.primaryAction?.onPress();
    expect(harness.actions[action]).toHaveBeenCalledWith(root);
  });

  it("preserves pinned actions including reorder against the full inbox", () => {
    const root = { ...parent, pinnedAt: parent.createdAt, pinOrderKey: "b" };
    const other = {
      ...parent,
      id: ThreadId.make("other"),
      pinnedAt: parent.createdAt,
      pinOrderKey: "a",
    };
    harness.threads = [root, other, child];
    render();
    expect(titles()).toEqual(expect.arrayContaining(["Move up", "Move down", "Unpin"]));
    const actions = harness.rows[0]?.menu?.actions;
    expect(actions?.find((item) => item.title === "Move up")?.attributes?.disabled).toBe(false);
    expect(actions?.find((item) => item.title === "Move down")?.attributes?.disabled).toBe(true);
    harness.rows[0]?.menu?.onPressAction?.({ nativeEvent: { event: "unpin" } });
    expect(harness.actions.unpinThread).toHaveBeenCalledWith(root);
  });

  it("does not grant root-only actions when opening a subgroup", () => {
    harness.threads = [
      parent,
      child,
      { ...child, id: ThreadId.make("leaf"), parentThreadId: child.id },
    ];
    render(child.id);
    expect(titles()).toEqual(["Archive", "Delete"]);
    expect(harness.rows.map((row) => row.depth)).toEqual([0, 1]);
    harness.swipes[0]?.primaryAction?.onPress();
    expect(harness.actions.archiveThread).toHaveBeenCalledWith(child);
  });

  it("honors older server capabilities and the legacy list preference", () => {
    harness.capabilities.threadSettlement = false;
    harness.capabilities.threadSnooze = false;
    harness.capabilities.threadPinning = false;
    render();
    expect(titles()).toEqual(expect.arrayContaining(["Archive", "Delete"]));
    expect(titles()).not.toContain("Settle");
    expect(titles()).not.toContain("Snooze");
    expect(titles()).not.toContain("Pin");
    harness.v2 = false;
    render();
    expect(harness.legacy).toEqual(["Parent", "Child"]);
  });
});

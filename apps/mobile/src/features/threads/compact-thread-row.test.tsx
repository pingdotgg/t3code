import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { StyleProp, ViewStyle } from "react-native";

vi.hoisted(() => {
  class TestEventEmitter {
    addListener() {
      return { remove() {} };
    }
    removeListener() {}
    removeAllListeners() {}
    emit() {
      return false;
    }
    listenerCount() {
      return 0;
    }
  }
  const global = globalThis as unknown as {
    __DEV__?: boolean;
    expo?: { EventEmitter: typeof TestEventEmitter; modules: Record<string, unknown> };
  };
  global.__DEV__ = false;
  global.expo = { EventEmitter: TestEventEmitter, modules: {} };
});
vi.mock("expo-crypto", () => ({
  getRandomBytes: (length: number) => new Uint8Array(length),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: async () => {},
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
vi.mock("expo-haptics", () => ({
  selectionAsync: vi.fn(),
}));
vi.mock("../../state/use-thread-pr", () => ({
  useThreadPr: () => null,
}));

import * as Haptics from "expo-haptics";
import { CompactThreadRow } from "./compact-thread-row";
import { presentThreadPr } from "../../state/thread-pr-presentation";
import { PendingTaskListRow, ThreadListRow } from "./thread-list-items";
import { ThreadListV2PendingRow, ThreadListV2Row } from "./thread-list-v2-items";
import type { PendingDraftTask } from "../../state/pending-new-tasks-model";
import {
  buildMobileThreadTree,
  mobileThreadTreeRows,
  relatedThreadRows,
  type MobileThreadShell,
} from "./mobile-thread-hierarchy";

interface TestProps {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  numberOfLines?: number;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  onAccessibilityTap?: () => void;
  actions?: NonNullable<ComponentProps<typeof CompactThreadRow>["menu"]>["actions"];
  onPressAction?: NonNullable<ComponentProps<typeof CompactThreadRow>["menu"]>["onPressAction"];
}
const harness = vi.hoisted(() => ({
  pressables: [] as TestProps[],
  menus: [] as TestProps[],
  views: [] as TestProps[],
  unread: false,
  navigate: vi.fn(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Platform: {
    OS: "ios",
    select: <T,>(options: { ios?: T; default?: T }) => options.ios ?? options.default,
  },
  useWindowDimensions: () => ({ width: 402 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
  View: (props: TestProps) => {
    harness.views.push(props);
    return createElement("div", null, props.children);
  },
  Pressable: (props: TestProps) => {
    harness.pressables.push(props);
    return createElement("button", { "aria-label": props.accessibilityLabel }, props.children);
  },
}));
vi.mock("../../components/AppText", () => ({
  AppText: (props: TestProps) =>
    createElement("span", { "data-lines": props.numberOfLines }, props.children),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../home/thread-swipe-actions", () => ({
  ThreadSwipeable: ({ children }: { children: (close: () => void) => ReactNode }) =>
    children(() => {}),
}));
vi.mock("./use-nested-thread-actions", () => ({
  useNestedThreadActions: () => ({
    actions: [],
    handleAction: () => {},
    openParent: () => {},
    dismissAgentRun: () => {},
  }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: (props: TestProps) => {
    harness.menus.push(props);
    return createElement("section", { "data-menu": true }, props.children);
  },
}));
vi.mock("../../lib/use-app-navigation", () => ({
  useAppNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("./thread-hierarchy-controls", () => ({
  useUnreadChildNotification: () => harness.unread,
}));
vi.mock("./thread-search-match", () => ({
  ThreadSearchMatchExcerpt: () => createElement("aside", null, "Matched excerpt"),
}));

const parent: MobileThreadShell = {
  environmentId: EnvironmentId.make("local"),
  id: ThreadId.make("parent"),
  projectId: ProjectId.make("project"),
  title: "Parent chat",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "hidden-branch",
  worktreePath: "/hidden-checkout",
  latestTurn: null,
  createdAt: "2026-09-06T10:00:00Z",
  updatedAt: "2026-09-06T10:00:00Z",
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

beforeEach(() => {
  harness.pressables.length = 0;
  harness.menus.length = 0;
  harness.views.length = 0;
  harness.unread = false;
  harness.navigate.mockClear();
});

describe("compact inbox row", () => {
  it.each([
    { mode: "legacy", sidebar: false },
    { mode: "legacy", sidebar: true },
    { mode: "v2", sidebar: false },
    { mode: "v2", sidebar: true },
  ] as const)(
    "indents $mode subchats in sidebar=$sidebar, including related groups",
    ({ mode, sidebar }) => {
      const child = { ...parent, id: ThreadId.make("child"), parentThreadId: parent.id };
      const hierarchy = relatedThreadRows(
        buildMobileThreadTree([parent, child]),
        `${parent.environmentId}:${parent.id}`,
      )[1]!;
      const shared = {
        thread: child,
        status: "ready" as const,
        hierarchy,
        hideRelated: true,
        onSelectThread: vi.fn(),
        onArchiveThread: vi.fn(),
        onDeleteThread: vi.fn(),
        onRegenerateThreadTitle: vi.fn(),
        titleRegenerationSupported: true,
        onSwipeableWillOpen: vi.fn(),
        onSwipeableClose: vi.fn(),
      };
      renderToStaticMarkup(
        mode === "legacy" ? (
          <ThreadListRow {...shared} variant={sidebar ? "sidebar" : "compact"} isLast />
        ) : (
          <ThreadListV2Row
            {...shared}
            variant="card"
            pane={sidebar ? "sidebar" : "screen"}
            snoozePresetMinute="2026-09-06T20:00"
            settlementSupported
            snoozeSupported
            pinningSupported
            onSettleThread={vi.fn()}
            onUnsettleThread={vi.fn()}
            onSnoozeThread={vi.fn()}
            onUnsnoozeThread={vi.fn()}
            onPinThread={vi.fn()}
            onUnpinThread={vi.fn()}
          />
        ),
      );
      expect(harness.views[0]?.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            paddingStart: (sidebar ? 12 : 18) + 12,
            paddingEnd: sidebar ? 12 : 18,
          }),
        ]),
      );
      expect(
        harness.pressables.some((item) => item.accessibilityLabel?.startsWith("Related")),
      ).toBe(false);
      harness.pressables[0]?.onPress?.();
      expect(shared.onSelectThread).toHaveBeenCalledWith(child);
    },
  );

  it.each([
    { depth: undefined, indent: 0 },
    { depth: 0, indent: 0 },
    { depth: 1, indent: 12 },
    { depth: 2, indent: 24 },
    { depth: 3, indent: 36 },
    { depth: 10, indent: 36 },
  ])("bounds the shared row indentation at depth $depth", ({ depth, indent }) => {
    renderToStaticMarkup(
      <CompactThreadRow
        title="Chat"
        timestamp="1m"
        status="ready"
        depth={depth}
        onPress={vi.fn()}
      />,
    );
    expect(harness.views[0]?.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paddingStart: 18 + indent, paddingEnd: 18 }),
      ]),
    );
  });

  it("announces the true nesting level beyond the visual indent cap", () => {
    renderToStaticMarkup(
      <CompactThreadRow title="Deep" timestamp="1m" status="ready" depth={10} onPress={vi.fn()} />,
    );
    expect(harness.pressables[0]?.accessibilityLabel).toContain("subchat, level 10");
    expect(harness.views[0]?.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingStart: 18 + 36 })]),
    );
  });

  it("keeps the Related entry for mixed groups with pruned descendants", () => {
    harness.unread = false;
    const activeChild = {
      ...parent,
      id: ThreadId.make("active-child"),
      parentThreadId: parent.id,
      hasPendingApprovals: true,
    };
    const readChild = {
      ...parent,
      id: ThreadId.make("read-child"),
      parentThreadId: parent.id,
      latestTurn: {
        turnId: TurnId.make("read-child-turn"),
        state: "completed" as const,
        requestedAt: parent.createdAt,
        startedAt: parent.createdAt,
        completedAt: parent.updatedAt,
        assistantMessageId: null,
      },
    };
    const hierarchy = mobileThreadTreeRows(
      buildMobileThreadTree([parent, activeChild, readChild], undefined, [], {
        readMarkers: { [`${parent.environmentId}:${readChild.id}`]: readChild.updatedAt },
      }),
      { includeAllDescendants: false },
    )[0]!;
    expect(hierarchy.relatedChildCount).toBeGreaterThan(hierarchy.childCount);
    renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="1m"
        status="ready"
        onPress={() => {}}
        related={{ thread: parent, hierarchy }}
      />,
    );
    const related = harness.pressables.find((item) =>
      item.accessibilityLabel?.startsWith("Related chats"),
    );
    expect(related?.accessibilityLabel).toContain(`${hierarchy.relatedChildCount}`);
    related?.onPress?.();
    expect(harness.navigate).toHaveBeenCalledWith("RelatedThreads", {
      environmentId: parent.environmentId,
      threadId: parent.id,
    });
  });

  it.each(["legacy", "v2"] as const)(
    "keeps the %s list consumer compact with inline nested threads",
    (mode) => {
      const rows = mobileThreadTreeRows(
        buildMobileThreadTree([
          parent,
          { ...parent, id: ThreadId.make("child"), parentThreadId: parent.id },
        ]),
        { includeAllDescendants: true },
      );
      expect(rows.map((row) => row.thread.id)).toEqual(["parent", "child"]);
      expect(rows[1]?.depth).toBe(1);
      const hierarchy = rows[0]!;
      const onSelectThread = vi.fn();
      const shared = {
        thread: parent,
        status: "ready" as const,
        hierarchy,
        onSelectThread,
        onArchiveThread: vi.fn(),
        onDeleteThread: vi.fn(),
        onRegenerateThreadTitle: vi.fn(),
        titleRegenerationSupported: true,
        onSwipeableWillOpen: vi.fn(),
        onSwipeableClose: vi.fn(),
      };
      const markup = renderToStaticMarkup(
        mode === "legacy" ? (
          <ThreadListRow {...shared} variant="compact" isLast />
        ) : (
          <ThreadListV2Row
            {...shared}
            variant="card"
            snoozePresetMinute="2026-09-06T20:00"
            settlementSupported
            snoozeSupported
            pinningSupported
            onSettleThread={vi.fn()}
            onUnsettleThread={vi.fn()}
            onSnoozeThread={vi.fn()}
            onUnsnoozeThread={vi.fn()}
            onPinThread={vi.fn()}
            onUnpinThread={vi.fn()}
            onMovePinnedThread={vi.fn()}
          />
        ),
      );
      expect(markup).toContain('data-lines="1"');
      expect(markup).not.toContain('data-lines="2"');
      expect(markup).not.toContain(parent.branch);
      expect(markup).not.toContain(parent.worktreePath);
      expect(markup).not.toContain("Child update");
      // Inline families hide the Related entry point; the parent still activates.
      expect(
        harness.pressables.some((item) => item.accessibilityLabel?.startsWith("Related")),
      ).toBe(false);
      harness.menus[0]?.onAccessibilityTap?.();
      expect(onSelectThread).toHaveBeenCalledWith(parent);
    },
  );

  it.each(["legacy", "v2"] as const)(
    "keeps related navigation after a completed child is acknowledged through the %s row consumer",
    (mode) => {
      const child = {
        ...parent,
        id: ThreadId.make("child"),
        parentThreadId: parent.id,
        latestTurn: {
          turnId: TurnId.make("child-turn"),
          state: "completed" as const,
          requestedAt: parent.createdAt,
          startedAt: parent.createdAt,
          completedAt: parent.updatedAt,
          assistantMessageId: null,
        },
      };
      const hierarchy = mobileThreadTreeRows(
        buildMobileThreadTree([parent, child], undefined, [], {
          readMarkers: { [`${parent.environmentId}:${child.id}`]: child.updatedAt },
        }),
      )[0]!;
      const onSelectThread = vi.fn();
      const shared = {
        thread: parent,
        status: "ready" as const,
        hierarchy,
        onSelectThread,
        onArchiveThread: vi.fn(),
        onDeleteThread: vi.fn(),
        onRegenerateThreadTitle: vi.fn(),
        titleRegenerationSupported: true,
        onSwipeableWillOpen: vi.fn(),
        onSwipeableClose: vi.fn(),
      };
      renderToStaticMarkup(
        mode === "legacy" ? (
          <ThreadListRow {...shared} variant="compact" isLast />
        ) : (
          <ThreadListV2Row
            {...shared}
            variant="card"
            snoozePresetMinute="2026-09-06T20:00"
            settlementSupported
            snoozeSupported
            pinningSupported
            onSettleThread={vi.fn()}
            onUnsettleThread={vi.fn()}
            onSnoozeThread={vi.fn()}
            onUnsnoozeThread={vi.fn()}
            onPinThread={vi.fn()}
            onUnpinThread={vi.fn()}
            onMovePinnedThread={vi.fn()}
          />
        ),
      );
      expect(hierarchy).toMatchObject({ childCount: 0, relatedChildCount: 1 });
      harness.pressables
        .find((item) => item.accessibilityLabel?.startsWith("Related chats"))
        ?.onPress?.();
      expect(harness.navigate).toHaveBeenCalledWith("RelatedThreads", {
        environmentId: parent.environmentId,
        threadId: parent.id,
      });
    },
  );

  it.each(["legacy", "v2"] as const)("renders editable drafts in the %s compact list", (mode) => {
    const draft: PendingDraftTask = {
      kind: "draft",
      key: "draft-task:new-task:one",
      draftKey: "new-task:one",
      environmentId: parent.environmentId,
      projectId: parent.projectId,
      projectTitle: undefined,
      projectCwd: undefined,
      branch: "hidden-branch",
      title: "Unsent idea",
      createdAt: parent.createdAt,
      draft: { text: "Unsent idea", attachments: [] },
    };
    const shared = {
      pendingTask: draft,
      onSelectPendingTask: vi.fn(),
      onDeletePendingTask: vi.fn(),
    };
    const markup = renderToStaticMarkup(
      mode === "legacy" ? (
        <PendingTaskListRow {...shared} variant="compact" isLast />
      ) : (
        <ThreadListV2PendingRow {...shared} showPendingDivider />
      ),
    );
    expect(markup).toContain('data-lines="1"');
    expect(markup).not.toContain("hidden-branch");
    const menu = harness.menus[0];
    expect(menu?.actions?.map((action) => action.title)).toEqual(["Discard"]);
    expect(harness.pressables[0]?.accessibilityLabel).toContain("Draft");
    harness.pressables[0]?.onPress?.();
    expect(shared.onSelectPendingTask).toHaveBeenCalledWith(draft);
    menu?.onPressAction?.({ nativeEvent: { event: "delete" } });
    expect(shared.onDeletePendingTask).toHaveBeenCalledWith(draft);
  });

  it("hides the related entry when children render inline and preserves activation", () => {
    const onPress = vi.fn();
    const hierarchy = mobileThreadTreeRows(
      buildMobileThreadTree([
        parent,
        {
          ...parent,
          id: ThreadId.make("child"),
          parentThreadId: parent.id,
          hasPendingApprovals: true,
        },
      ]),
      { includeAllDescendants: true },
    )[0]!;
    harness.unread = true;
    const markup = renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="2m"
        status="ready"
        onPress={onPress}
        menu={{ actions: [] }}
        related={{ thread: parent, hierarchy }}
      />,
    );
    expect(markup).not.toContain("Child update");
    expect(markup).not.toContain(parent.branch);
    expect(markup).not.toContain(parent.worktreePath);
    expect(markup).toContain('data-lines="1"');
    expect(renderToStaticMarkup(harness.menus[0]?.children)).not.toContain("Related chats");
    expect(renderToStaticMarkup(harness.menus[0]?.children)).toContain(">2m<");
    expect(harness.menus[0]?.accessibilityLabel).toBe("Parent chat, 2m");
    harness.menus[0]?.onAccessibilityTap?.();
    expect(onPress).toHaveBeenCalledOnce();
    // Inline families replace the Related entry point.
    expect(
      harness.pressables.some((item) => item.accessibilityLabel?.startsWith("Related chats")),
    ).toBe(false);
  });

  it("renders nested subchats compact with rail, smaller type, and level announcement", () => {
    renderToStaticMarkup(
      <CompactThreadRow title="Child" timestamp="1m" status="ready" depth={1} onPress={() => {}} />,
    );
    expect(harness.pressables[0]?.accessibilityLabel).toContain("subchat, level 1");
    expect(harness.views[0]?.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingStart: 30 })]),
    );
  });

  it("centers the nested rail line under its icon at the compact height", () => {
    renderToStaticMarkup(
      <CompactThreadRow title="Child" timestamp="1m" status="ready" depth={1} onPress={() => {}} />,
    );
    const entries = harness.views.flatMap((view) =>
      Array.isArray(view.style) ? view.style : [view.style],
    );
    const railLine = entries.find(
      (entry) =>
        typeof entry === "object" && entry !== null && "width" in entry && entry.width === 2,
    );
    expect(railLine).toMatchObject({ width: 2, left: 7, top: 5, bottom: 5 });
    expect(
      entries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "minHeight" in entry &&
          entry.minHeight === 36,
      ),
    ).toBe(true);
  });

  it("toggles inline subchats from the parent chevron and restores Related while collapsed", () => {
    const onToggleExpanded = vi.fn();
    const hierarchy = mobileThreadTreeRows(
      buildMobileThreadTree([
        parent,
        { ...parent, id: ThreadId.make("child"), parentThreadId: parent.id },
      ]),
      { includeAllDescendants: true },
    )[0]!;
    expect(hierarchy.isExpanded).toBe(true);
    const shared = {
      title: parent.title,
      timestamp: "2m",
      status: "ready" as const,
      onPress: vi.fn(),
      menu: { actions: [] },
      related: { thread: parent, hierarchy },
    };
    renderToStaticMarkup(
      <CompactThreadRow {...shared} expanded onToggleExpanded={onToggleExpanded} />,
    );
    const collapse = harness.pressables.find((item) =>
      item.accessibilityLabel?.startsWith("Collapse"),
    );
    expect(collapse?.accessibilityLabel).toContain("Collapse 1 subchat");
    expect(harness.menus[0]?.accessibilityLabel).toContain("1 subchat, expanded");
    // Inline families replace the Related entry point while expanded.
    expect(
      harness.pressables.some((item) => item.accessibilityLabel?.startsWith("Related chats")),
    ).toBe(false);
    collapse?.onPress?.();
    expect(onToggleExpanded).toHaveBeenCalledOnce();
    expect(Haptics.selectionAsync).toHaveBeenCalledOnce();

    harness.pressables.length = 0;
    harness.menus.length = 0;
    harness.views.length = 0;
    renderToStaticMarkup(
      <CompactThreadRow {...shared} expanded={false} onToggleExpanded={onToggleExpanded} />,
    );
    const expand = harness.pressables.find((item) => item.accessibilityLabel?.startsWith("Expand"));
    expect(expand?.accessibilityLabel).toContain("Expand 1 subchat");
    // A collapsed group keeps its Related entry point for the hidden rows.
    expect(
      harness.pressables.some((item) => item.accessibilityLabel?.startsWith("Related chats")),
    ).toBe(true);
  });

  it("shares the parent surface on nested rows, keeping indentation for grouping", () => {
    const backgroundOf = (element: (typeof harness.views)[number]) => {
      const styles = Array.isArray(element?.style) ? element.style : [element?.style];
      return styles.find(
        (entry) => typeof entry === "object" && entry !== null && "backgroundColor" in entry,
      ) as { backgroundColor?: unknown } | undefined;
    };
    renderToStaticMarkup(
      <CompactThreadRow title="Parent" timestamp="2m" status="ready" onPress={() => {}} />,
    );
    const parentBackground = backgroundOf(harness.views[0])?.backgroundColor;
    harness.views.length = 0;
    renderToStaticMarkup(
      <CompactThreadRow title="Child" timestamp="1m" status="ready" depth={1} onPress={() => {}} />,
    );
    expect(backgroundOf(harness.views[0])?.backgroundColor).toBe(parentBackground);
    expect(harness.views[0]?.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingStart: 30 })]),
    );
  });

  it("hides the chevron without a toggle handler or children", () => {
    renderToStaticMarkup(
      <CompactThreadRow title={parent.title} timestamp="2m" status="ready" onPress={() => {}} />,
    );
    expect(
      harness.pressables.some(
        (item) =>
          item.accessibilityLabel?.startsWith("Collapse") ||
          item.accessibilityLabel?.startsWith("Expand"),
      ),
    ).toBe(false);
  });

  it("does not repeat the parent's status on quiet inline children", () => {
    const working = { ...parent, hasPendingQueuedTurn: true };
    const rows = mobileThreadTreeRows(
      buildMobileThreadTree([
        working,
        { ...parent, id: ThreadId.make("child"), parentThreadId: parent.id },
      ]),
      { includeAllDescendants: true },
    );
    expect(rows.map((row) => row.thread.id)).toEqual(["parent", "child"]);
    renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="2m"
        status="working"
        onPress={() => {}}
        related={{ thread: working, hierarchy: rows[0] }}
      />,
    );
    expect(harness.pressables[0]?.accessibilityLabel).toContain("Working");
    expect(
      harness.pressables.some((item) => item.accessibilityLabel?.includes("working in group")),
    ).toBe(false);
  });

  it("includes the timestamp and search excerpt in the primary tap and long-press target", () => {
    const onPress = vi.fn();
    renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="2m"
        status="ready"
        onPress={onPress}
        menu={{ actions: [] }}
        searchMatch={{
          environmentId: parent.environmentId,
          threadId: parent.id,
          messageId: MessageId.make("message-needle"),
          projectId: parent.projectId,
          source: "user",
          snippet: "Needle",
          messageCreatedAt: parent.createdAt,
        }}
      />,
    );
    const content = renderToStaticMarkup(harness.pressables[0]?.children);
    expect(content).toContain(">2m<");
    expect(content).toContain("Matched excerpt");
    expect(renderToStaticMarkup(harness.menus[0]?.children)).toContain("Matched excerpt");
    expect(harness.menus[0]?.accessibilityLabel).toContain("You: Needle");
    harness.pressables[0]?.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("renders a pull request badge alongside the thread row", () => {
    const pullRequest = presentThreadPr(
      {
        number: 3774,
        title: "Desktop-style pull request indicator",
        url: "https://github.com/t3tools/t3code/pull/3774",
        baseRef: "main",
        headRef: "feature/pr",
        state: "open",
      },
      undefined,
    );
    const markup = renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="2m"
        status="ready"
        pullRequest={pullRequest}
        onPress={() => {}}
      />,
    );
    expect(markup).toContain(">3774<");
    expect(
      harness.pressables.find((item) => item.accessibilityLabel === "#3774 pull request open"),
    ).toBeDefined();
  });

  it.each(["working", "approval", "input", "failed", "queued", "draft", "plan-ready"] as const)(
    "announces %s without adding routine status text",
    (status) => {
      const markup = renderToStaticMarkup(
        <CompactThreadRow title="Chat" timestamp="1m" status={status} onPress={() => {}} />,
      );
      expect(harness.pressables[0]?.accessibilityLabel).not.toBe("Chat, 1m");
      if (status === "working") expect(markup).not.toContain(">Working<");
      expect(harness.pressables).toHaveLength(1);
    },
  );

  it("keeps unread group activity reachable when the last related chat disappears", () => {
    harness.unread = true;
    renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="1m"
        status="ready"
        onPress={() => {}}
        related={{ thread: parent }}
      />,
    );
    expect(harness.pressables[1]?.accessibilityLabel).toContain("unread activity");
  });
});

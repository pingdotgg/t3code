import { uuidv4 } from "../../lib/uuid";
import { useNavigation } from "@react-navigation/native";
import {
  claimThreadOpen,
  nextShownOrder,
  threadSearchSubject,
  type EnvironmentThreadSearchMatch,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import {
  foldSearchQuery,
  PALETTE_MESSAGE_LIMIT,
  rankMessageMatches,
  splitSearchText,
  pickedQuery,
  threadRecentUse,
} from "@t3tools/shared/paletteSearch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  Text as NativeText,
  TextInput,
  useWindowDimensions,
  View,
  type TextInputInstance,
} from "react-native";

import { GestureHandlerRootView } from "react-native-gesture-handler";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { RowPressable } from "../../components/ui/RowPressable";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { deriveBottomControlInsets } from "../../lib/reserved-regions";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { T3KeyboardCommands } from "../../native/T3KeyboardCommands";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadSearchMatchExcerpt } from "../threads/thread-search-match";
import {
  filterCommandPaletteItems,
  nextPaletteIndex,
  type CommandPaletteItem,
  type CommandPaletteResult,
} from "./commandPaletteItems";
import { parseActiveThreadPath, type HardwareKeyboardCommand } from "./hardwareKeyboardCommands";
import { threadJumpIndex } from "./threadKeyboardShortcuts";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

const PALETTE_COMMANDS: ReadonlyArray<HardwareKeyboardCommand> = [
  "commandPalette",
  "paletteDismiss",
  "paletteNext",
  "palettePrevious",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
];
const ROW_HEIGHT = 50;
// The "In messages" label above the first message match; server results always come last.
const SECTION_LABEL_HEIGHT = 26;

const ACTION_ICONS: Record<string, AppSymbolName> = {
  newTask: "square.and.pencil",
  newThread: "square.and.pencil",
  addProject: "folder.badge.plus",
  settings: "gearshape",
  appearance: "paintbrush",
  environments: "desktopcomputer",
  usage: "chart.bar.xaxis",
  archive: "archivebox",
  files: "doc.text",
  terminal: "terminal",
  review: PullRequestGlyph.pullRequest,
  copyThreadReference: "link",
};

function itemIcon(item: CommandPaletteItem): AppSymbolName {
  if (item.kind === "thread") return "text.bubble";
  return ACTION_ICONS[item.key] ?? "ellipsis";
}

function PaletteRow(props: {
  readonly item: CommandPaletteResult;
  readonly index: number;
  readonly selected: boolean;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery: string;
  readonly onSelect: () => void;
}) {
  const foregroundClassName = props.selected
    ? "text-thread-selected-foreground"
    : "text-foreground";
  const mutedForegroundClassName = props.selected
    ? "text-thread-selected-foreground-muted"
    : "text-foreground-muted";
  return (
    <RowPressable
      accessibilityRole="button"
      interactionOpacity={props.selected ? 0 : 1}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onSelect}
      className={
        props.selected
          ? "mx-2 flex-row items-center gap-3 rounded-xl bg-thread-selected px-3"
          : "mx-2 flex-row items-center gap-3 rounded-xl px-3"
      }
      style={{ height: ROW_HEIGHT }}
    >
      <View className="w-7 items-center">
        {props.item.project ? (
          <ProjectFavicon
            environmentId={props.item.project.environmentId}
            faviconPath={props.item.project.faviconPath}
            projectIcon={props.item.project.projectIcon}
            projectTitle={props.item.project.title}
            size={20}
            workspaceRoot={props.item.project.workspaceRoot}
          />
        ) : (
          <SymbolView
            name={itemIcon(props.item)}
            size={20}
            tintColorClassName={
              props.selected ? "accent-thread-selected-foreground" : "accent-icon"
            }
          />
        )}
      </View>
      <View className="flex-1">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className={cn("shrink text-base", foregroundClassName)}>
            {props.item.titleRanges?.length
              ? splitSearchText(props.item.title, props.item.titleRanges).map((part) => (
                  <Text
                    key={part.start}
                    className={cn("text-base", part.highlighted && "font-t3-bold")}
                  >
                    {part.text}
                  </Text>
                ))
              : props.item.title}
          </Text>
          {/* The second line shows the snippet or hint, so keep where the thread
              lives, unless the hint already names it. */}
          {(props.searchMatch ||
            (props.item.matchHint &&
              props.item.matchHint.label !== "Project" &&
              props.item.matchHint.label !== "Environment")) &&
          props.item.detail ? (
            <Text
              numberOfLines={1}
              className={cn("max-w-[45%] shrink-0 text-sm", mutedForegroundClassName)}
            >
              {props.item.detail}
            </Text>
          ) : null}
        </View>
        {props.searchMatch ? (
          <ThreadSearchMatchExcerpt
            match={props.searchMatch}
            query={props.searchQuery}
            selected={props.selected}
            compact
          />
        ) : props.item.matchHint ? (
          <Text numberOfLines={1} className={cn("text-sm", mutedForegroundClassName)}>
            {props.item.matchHint.label}:{" "}
            {splitSearchText(props.item.matchHint.text, props.item.matchHint.ranges).map((part) => (
              <Text key={part.start} className={cn("text-sm", part.highlighted && "font-t3-bold")}>
                {part.text}
              </Text>
            ))}
          </Text>
        ) : props.item.detail ? (
          <Text numberOfLines={1} className={cn("text-sm", mutedForegroundClassName)}>
            {props.item.detail}
          </Text>
        ) : null}
      </View>
      {props.index < 9 ? (
        <NativeText
          className={cn("w-8 shrink-0 text-right text-sm tabular-nums", mutedForegroundClassName)}
        >
          ⌘{props.index + 1}
        </NativeText>
      ) : null}
    </RowPressable>
  );
}

/** Mounted only while open, so the app root does not subscribe to the full thread catalog. */
export function CommandPalette(props: {
  readonly pathname: string;
  readonly onClose: () => void;
  readonly onCommand: (command: HardwareKeyboardCommand) => void;
}) {
  const navigation = useNavigation();
  const { themeVariables } = useAppearancePreferences();
  const { selectThread, selectThreadRoute } = useAdaptiveWorkspaceLayout();
  const runCommand = props.onCommand;
  const projects = useProjects();
  const threads = useThreadShells();
  const activeThreadRef = useMemo(() => parseActiveThreadPath(props.pathname), [props.pathname]);
  const activeThread = useThreadShell(activeThreadRef);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const environments = useWorkspaceEnvironments();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [query, setQuery] = useState("");
  // Ranking is relative to when the palette opened, so rows do not reorder as time passes.
  const [now] = useState(() => Date.now());
  const [selection, setSelection] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const pendingAction = useRef<(() => void) | null>(null);
  const closing = useRef(false);
  const inputRef = useRef<TextInputInstance>(null);
  const listRef = useRef<FlatList<CommandPaletteResult>>(null);
  const { width, height } = useWindowDimensions();
  // The palette floats above every column, so it keeps itself inside the window's side insets
  // and to one side of a book fold.
  const bounds = deriveBottomControlInsets(useNativeLayoutMetrics());
  const searchEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const search = useThreadSearch(searchEnvironmentIds, query.startsWith(">") ? "" : query);
  const contentMatchByKey = useMemo(
    () =>
      new Map(
        search.matches
          .filter((match) => match.source === "user" || match.source === "assistant")
          .map((match) => [scopedThreadKey(match.environmentId, match.threadId), match]),
      ),
    [search.matches],
  );
  const items = useMemo(() => {
    const actions: CommandPaletteItem[] = [
      {
        key: "newTask",
        kind: "action",
        title: "New thread in…",
        searchTerms: ["new task", "chat", "create", "project"],
        run: () => runCommand("newTask"),
      },
      {
        key: "addProject",
        kind: "action",
        title: "Add project",
        searchTerms: ["folder", "clone", "repository", "git"],
        run: () => navigation.navigate("AddProject"),
      },
      {
        key: "settings",
        kind: "action",
        title: "Open settings",
        searchTerms: ["preferences", "configuration"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "Settings" },
          }),
      },
      {
        key: "appearance",
        kind: "action",
        title: "Appearance",
        searchTerms: ["theme", "colors", "dark", "light"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsAppearance" },
          }),
      },
      {
        key: "environments",
        kind: "action",
        title: "Manage environments",
        searchTerms: ["connections", "server", "remote"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsEnvironments" },
          }),
      },
      {
        key: "scheduledTasks",
        kind: "action",
        title: "Scheduled tasks",
        searchTerms: ["schedule", "automations", "recurring"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsScheduledTasks" },
          }),
      },
      {
        key: "usage",
        kind: "action",
        title: "Usage",
        searchTerms: ["limits", "accounts", "quota"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsUsage" },
          }),
      },
      {
        key: "archive",
        kind: "action",
        title: "Archived threads",
        searchTerms: ["restore", "history"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsArchive" },
          }),
      },
    ];
    const projectByKey = new Map(
      projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
    );
    const activeProject = activeThread
      ? projectByKey.get(scopedProjectKey(activeThread.environmentId, activeThread.projectId))
      : null;
    if (activeProject) {
      actions.unshift({
        key: "newThread",
        kind: "action",
        title: `New thread in ${activeProject.title}`,
        searchTerms: ["new task", "chat", "create"],
        run: () =>
          selectThreadRoute({
            draft: {
              requestId: uuidv4(),
              environmentId: activeProject.environmentId,
              projectId: activeProject.id,
              title: activeProject.title,
            },
          }),
      });
    }
    if (activeThreadRef) {
      const threadActions = [
        ["files", "Go to file", ["open", "files", "browse", "search"]],
        ["terminal", "Open terminal", ["shell", "console"]],
        ["review", "Review changes", ["diff", "git", "pull request"]],
        ["copyThreadReference", "Copy PR link or thread ID", ["reference", "clipboard"]],
      ] as const;
      actions.push(
        ...threadActions.map(([command, title, searchTerms]) => ({
          key: command,
          kind: "action" as const,
          title,
          searchTerms,
          run: () => runCommand(command),
        })),
      );
    }
    const projectItems: CommandPaletteItem[] = projects.map((project) => ({
      key: `project:${scopedProjectKey(project.environmentId, project.id)}`,
      kind: "project",
      project,
      title: project.title,
      detail: `New thread · ${savedConnectionsById[project.environmentId]?.environmentLabel ?? project.environmentId}`,
      searchTerms: [project.workspaceRoot, "new thread", "project"],
      run: () =>
        selectThreadRoute({
          draft: {
            requestId: uuidv4(),
            environmentId: project.environmentId,
            projectId: project.id,
            title: project.title,
          },
        }),
    }));
    const threadItems: CommandPaletteItem[] = threads
      .filter(
        (thread) =>
          thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent",
      )
      .map((thread) => {
        const project = projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId));
        const environment =
          savedConnectionsById[thread.environmentId]?.environmentLabel ?? thread.environmentId;
        return {
          key: scopedThreadKey(thread.environmentId, thread.id),
          kind: "thread",
          title: thread.title || "Untitled thread",
          detail: [project?.title, environment].filter(Boolean).join(" · "),
          searchTerms: [],
          threadSearch: threadSearchSubject(
            thread,
            project?.title,
            environments.length > 1 ? environment : null,
          ),
          // Last among threads: picking the thread already open does nothing.
          ...(thread.environmentId === activeThread?.environmentId && thread.id === activeThread.id
            ? { secondary: true }
            : {}),
          run: () => selectThread(thread),
        };
      });
    // Recent means used recently: written in or opened, whichever is later.
    threadItems.sort(
      (left, right) =>
        (right.threadSearch ? threadRecentUse(right.threadSearch) : 0) -
        (left.threadSearch ? threadRecentUse(left.threadSearch) : 0),
    );
    return [...actions, ...projectItems, ...threadItems];
  }, [
    activeThread,
    activeThreadRef,
    environments.length,
    navigation,
    projects,
    runCommand,
    savedConnectionsById,
    selectThread,
    selectThreadRoute,
    threads,
  ]);
  const rankedMessageKeys = useMemo(() => {
    const subjectByKey = new Map(
      items.flatMap((item) => (item.threadSearch ? [[item.key, item.threadSearch] as const] : [])),
    );
    const keyOf = (match: EnvironmentThreadSearchMatch) =>
      scopedThreadKey(match.environmentId, match.threadId);
    return rankMessageMatches(
      search.matches,
      (match) => subjectByKey.get(keyOf(match)),
      foldSearchQuery(query),
      now,
      { withoutTitleMatches: true },
    ).map(keyOf);
  }, [items, now, query, search.matches]);
  // Rows already shown keep their places when a slower environment answers.
  const [shownOrder, setShownOrder] = useState<ShownOrder | null>(null);
  const messageOrder = nextShownOrder(
    shownOrder,
    search.query,
    rankedMessageKeys,
    PALETTE_MESSAGE_LIMIT,
  );
  if (messageOrder !== shownOrder) setShownOrder(messageOrder);
  const messageMatchKeys = useMemo(
    () => messageOrder.keys.slice(0, messageOrder.shown),
    [messageOrder.keys, messageOrder.shown],
  );
  const results = useMemo(() => {
    const ranked = filterCommandPaletteItems(items, query, messageMatchKeys, now);
    // Recent threads leave out the open one, which would always lead them.
    const activeKey = activeThread
      ? scopedThreadKey(activeThread.environmentId, activeThread.id)
      : null;
    return query.trim() ? ranked : ranked.filter((item) => item.key !== activeKey);
  }, [activeThread, items, messageMatchKeys, now, query]);
  const runResult = (item: CommandPaletteResult) => {
    const thread =
      item.kind === "thread" && query.trim() && !query.startsWith(">")
        ? threads.find(
            (candidate) => scopedThreadKey(candidate.environmentId, candidate.id) === item.key,
          )
        : undefined;
    // A message result opens the thread at that message.
    const messageId = item.fromMessages ? contentMatchByKey.get(item.key)?.messageId : undefined;
    if (messageId) requestThreadMessageJump(item.key, messageId);
    // A pick sends its open with the query, always, so the server records it;
    // the thread screen then skips its own open. The open thread is no pick.
    if (thread && !item.secondary) claimThreadOpen(thread.environmentId, thread.id, Date.now());
    if (thread && thread.lastVisitedAt !== undefined && !item.secondary) {
      void visitThread({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          visitedAt: thread.updatedAt,
          opened: true,
          searchQuery: pickedQuery(query),
        },
      });
    }
    item.run();
  };
  const firstMessageIndex = results.findIndex((item) => item.fromMessages);
  const selectedIndex = Math.max(
    0,
    results.findIndex((item) => item.key === selection),
  );
  const selectedKey = results[selectedIndex]?.key;
  useEffect(() => {
    if (selectedIndex === 0) {
      // Centering before the list measures its height scrolls half the first row out of view.
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    } else if (selectedKey !== undefined) {
      listRef.current?.scrollToIndex({ index: selectedIndex, animated: false, viewPosition: 0.5 });
    }
  }, [selectedIndex, selectedKey]);

  const dismissed = useRef(false);
  const handleDismissed = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    // Present navigation sheets only after UIKit has dismissed this modal.
    props.onClose();
    pendingAction.current?.();
  }, [props]);

  // iOS drops Modal onDismiss when the VC is dismissed mid-presentation (e.g.
  // ⌘K during the fade-in) or raced by another sheet — without a fallback the
  // palette stays mounted-but-invisible and ⌘K dead-ends on a stale open state.
  useEffect(() => {
    if (visible) return;
    const fallback = setTimeout(handleDismissed, 400);
    return () => clearTimeout(fallback);
  }, [visible, handleDismissed]);

  function close(run?: () => void) {
    if (closing.current) return;
    closing.current = true;
    pendingAction.current = run ?? null;
    setVisible(false);
  }

  function onCommand(command: HardwareKeyboardCommand) {
    if (command === "commandPalette" || command === "paletteDismiss") {
      close();
    } else if (command === "paletteNext" || command === "palettePrevious") {
      setSelection(
        results[nextPaletteIndex(selectedIndex, command === "paletteNext" ? 1 : -1, results.length)]
          ?.key ?? null,
      );
    } else {
      const item = results[threadJumpIndex(command)];
      if (item) close(() => runResult(item));
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onShow={() => inputRef.current?.focus()}
      onRequestClose={() => close()}
      onDismiss={handleDismissed}
    >
      <GestureHandlerRootView className="flex-1">
        <T3KeyboardCommands enabledCommands={PALETTE_COMMANDS} onCommand={onCommand}>
          <KeyboardAvoidingView
            behavior="padding"
            className="flex-1 items-center justify-center py-4"
            style={{ paddingLeft: 16 + bounds.left, paddingRight: 16 + bounds.right }}
          >
            <Pressable
              className="absolute inset-0 bg-backdrop"
              accessibilityLabel="Close command palette"
              onPress={() => close()}
            />
            <GlassSurface
              accessibilityViewIsModal
              className="bg-sheet"
              tintColorClassName="accent-sheet/20"
              fallbackColor={themeVariables["--color-sheet"]}
              style={{
                width: Math.min(600, width - 32 - bounds.left - bounds.right),
                height: Math.min(520, height - 80),
                borderRadius: 20,
              }}
            >
              <View className="px-3 pb-2.5 pt-3.5">
                <View className="h-[38px] flex-row items-center gap-1.5 pr-2.5 pl-[11px]">
                  <SymbolView
                    name="magnifyingglass"
                    size={15}
                    tintColorClassName="accent-foreground-muted"
                    type="monochrome"
                  />
                  <TextInput
                    ref={inputRef}
                    accessibilityLabel="Search commands, projects, and threads"
                    placeholder="Search commands, projects, and threads…"
                    placeholderTextColorClassName="accent-placeholder"
                    autoCorrect={false}
                    autoCapitalize="none"
                    clearButtonMode="while-editing"
                    className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-foreground"
                    value={query}
                    onChangeText={(value) => {
                      setQuery(value);
                      setSelection(null);
                      listRef.current?.scrollToOffset({ offset: 0, animated: false });
                    }}
                    returnKeyType="go"
                    submitBehavior="submit"
                    onSubmitEditing={() => {
                      const item = results[selectedIndex];
                      if (item) close(() => runResult(item));
                    }}
                  />
                </View>
              </View>
              <FlatList
                ref={listRef}
                data={results}
                extraData={selectedKey}
                keyboardShouldPersistTaps="handled"
                keyExtractor={(item) => item.key}
                getItemLayout={(_, index) => ({
                  length: ROW_HEIGHT + (index === firstMessageIndex ? SECTION_LABEL_HEIGHT : 0),
                  offset:
                    ROW_HEIGHT * index +
                    (firstMessageIndex !== -1 && index > firstMessageIndex
                      ? SECTION_LABEL_HEIGHT
                      : 0),
                  index,
                })}
                contentContainerClassName="pb-2"
                ListEmptyComponent={
                  <Text className="p-5 text-center text-foreground-muted">
                    {search.isPending ? "Searching…" : "No results"}
                  </Text>
                }
                // Message results from slower environments may still arrive below.
                ListFooterComponent={
                  results.length > 0 && search.isPending && !query.startsWith(">") ? (
                    <Text className="px-5 pt-2 text-xs text-foreground-muted">
                      Searching messages…
                    </Text>
                  ) : undefined
                }
                renderItem={({ item, index }) => (
                  <>
                    {index === firstMessageIndex ? (
                      <Text
                        className="px-5 pt-2 text-xs text-foreground-muted"
                        style={{ height: SECTION_LABEL_HEIGHT }}
                      >
                        In messages
                      </Text>
                    ) : null}
                    <PaletteRow
                      item={item}
                      index={index}
                      selected={item.key === selectedKey}
                      searchMatch={item.fromMessages ? contentMatchByKey.get(item.key) : undefined}
                      searchQuery={search.query}
                      onSelect={() => close(() => runResult(item))}
                    />
                  </>
                )}
              />
            </GlassSurface>
          </KeyboardAvoidingView>
        </T3KeyboardCommands>
      </GestureHandlerRootView>
    </Modal>
  );
}

import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
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

import { GlassSurface } from "../../components/GlassSurface";
import { RowPressable } from "../../components/RowPressable";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { T3KeyboardCommands } from "../../native/T3KeyboardCommands";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { ThreadSearchMatchExcerpt } from "../threads/thread-search-match";
import {
  filterCommandPaletteItems,
  nextPaletteIndex,
  type CommandPaletteItem,
} from "./commandPaletteItems";
import { parseActiveThreadPath, type HardwareKeyboardCommand } from "./hardwareKeyboardCommands";
import { threadJumpIndex } from "./threadKeyboardShortcuts";

const PALETTE_COMMANDS: ReadonlyArray<HardwareKeyboardCommand> = [
  "commandPalette",
  "paletteDismiss",
  "paletteNext",
  "palettePrevious",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
];
const ROW_HEIGHT = 50;

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
  review: "arrow.triangle.pull",
  copyThreadReference: "link",
};

function itemIcon(item: CommandPaletteItem): AppSymbolName {
  if (item.kind === "project") return "folder";
  if (item.kind === "thread") return "text.bubble";
  return ACTION_ICONS[item.key] ?? "ellipsis";
}

function PaletteRow(props: {
  readonly item: CommandPaletteItem;
  readonly index: number;
  readonly selected: boolean;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery: string;
  readonly onSelect: () => void;
}) {
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onSelect}
      className={
        props.selected
          ? "mx-2 flex-row items-center gap-3 rounded-xl bg-primary/10 px-3"
          : "mx-2 flex-row items-center gap-3 rounded-xl px-3"
      }
      style={{ height: ROW_HEIGHT }}
    >
      <View className="w-7 items-center">
        <SymbolView name={itemIcon(props.item)} size={20} tintColorClassName="accent-icon" />
      </View>
      <View className="flex-1">
        <Text numberOfLines={1} className="text-base">
          {props.item.title}
        </Text>
        {props.searchMatch ? (
          <ThreadSearchMatchExcerpt match={props.searchMatch} query={props.searchQuery} compact />
        ) : props.item.detail ? (
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {props.item.detail}
          </Text>
        ) : null}
      </View>
      {props.index < 9 ? (
        <NativeText className="w-8 shrink-0 text-right text-sm tabular-nums text-foreground-muted">
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
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const runCommand = props.onCommand;
  const projects = useProjects();
  const threads = useThreadShells();
  const activeThreadRef = useMemo(() => parseActiveThreadPath(props.pathname), [props.pathname]);
  const activeThread = useThreadShell(activeThreadRef);
  const { environments } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const pendingAction = useRef<(() => void) | null>(null);
  const closing = useRef(false);
  const inputRef = useRef<TextInputInstance>(null);
  const listRef = useRef<FlatList<CommandPaletteItem>>(null);
  const { width, height } = useWindowDimensions();
  const searchEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const search = useThreadSearch(searchEnvironmentIds, query.startsWith(">") ? "" : query);
  const matchedThreadKeys = useMemo(
    () =>
      new Set(search.matches.map((match) => scopedThreadKey(match.environmentId, match.threadId))),
    [search.matches],
  );
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
        run: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
      },
      {
        key: "addProject",
        kind: "action",
        title: "Add project",
        searchTerms: ["folder", "clone", "repository", "git"],
        run: () => navigation.navigate("NewTaskSheet", { screen: "AddProject" }),
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
          navigation.navigate("NewTaskSheet", {
            screen: "NewTaskDraft",
            params: {
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
      title: project.title,
      detail: `New thread · ${savedConnectionsById[project.environmentId]?.environmentLabel ?? project.environmentId}`,
      searchTerms: [project.workspaceRoot, "new thread", "project"],
      run: () =>
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: project.environmentId,
            projectId: project.id,
            title: project.title,
          },
        }),
    }));
    const threadItems: CommandPaletteItem[] = threads
      .filter((thread) => thread.archivedAt === null)
      .sort((left, right) =>
        (right.latestUserMessageAt ?? right.updatedAt).localeCompare(
          left.latestUserMessageAt ?? left.updatedAt,
        ),
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
          searchTerms: [
            project?.title ?? "",
            environment,
            thread.branch ?? "",
            ...threadPullRequestSearchTerms(thread),
          ],
          run: () => selectThread(thread),
        };
      });
    return [...actions, ...projectItems, ...threadItems];
  }, [
    activeThread,
    activeThreadRef,
    navigation,
    projects,
    runCommand,
    savedConnectionsById,
    selectThread,
    threads,
  ]);
  const results = useMemo(
    () => filterCommandPaletteItems(items, query, matchedThreadKeys),
    [items, matchedThreadKeys, query],
  );
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
      if (item) close(item.run);
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
            className="flex-1 items-center justify-center p-4"
          >
            <Pressable
              className="absolute inset-0 bg-black/15"
              accessibilityLabel="Close command palette"
              onPress={() => close()}
            />
            <GlassSurface
              accessibilityViewIsModal
              className="bg-sheet/70"
              tintColorClassName="accent-sheet/20"
              style={{
                width: Math.min(600, width - 32),
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
                      if (item) close(item.run);
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
                  length: ROW_HEIGHT,
                  offset: ROW_HEIGHT * index,
                  index,
                })}
                contentContainerClassName="pb-2"
                ListEmptyComponent={
                  <Text className="p-5 text-center text-foreground-muted">
                    {search.isPending ? "Searching…" : "No results"}
                  </Text>
                }
                renderItem={({ item, index }) => (
                  <PaletteRow
                    item={item}
                    index={index}
                    selected={item.key === selectedKey}
                    searchMatch={
                      item.kind === "thread" ? contentMatchByKey.get(item.key) : undefined
                    }
                    searchQuery={query}
                    onSelect={() => close(item.run)}
                  />
                )}
              />
            </GlassSurface>
          </KeyboardAvoidingView>
        </T3KeyboardCommands>
      </GestureHandlerRootView>
    </Modal>
  );
}

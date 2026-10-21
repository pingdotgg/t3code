import { SpaceProjectsOverview } from "./SpaceProjectsOverview";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type ScrollViewInstance,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  assignProjectSpace,
  assignThreadSpace,
  createSpace,
  removeSpace,
  resolveProjectSpace,
  resolveThreadSpace,
  selectSpace,
  updateSpace,
} from "@t3tools/client-runtime/state/spaces";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useThreadShells } from "../../state/entities";
import { useMobileSpaces } from "../../state/spaces";
import { MOBILE_THEME_OPTIONS } from "../../lib/mobileTheme";
import { uuidv4 } from "../../lib/uuid";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { SettingsRow } from "../settings/components/SettingsRow";

type AssignmentTarget =
  | { kind: "project"; ref: ScopedProjectRef; title: string }
  | {
      kind: "thread";
      ref: ScopedThreadRef;
      title: string;
    };

function Action(props: {
  readonly label: string;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className="min-h-11 flex-row items-center rounded-xl px-3 py-3"
    >
      <Text className="flex-1 text-foreground">{props.label}</Text>
      {props.selected ? <Text className="text-primary-text">✓</Text> : null}
    </Pressable>
  );
}

export function SpacesControl(props: {
  readonly settings?: boolean;
  readonly onEmptySpace?: () => void;
  readonly onSelectThread?: (thread: EnvironmentThreadShell) => void;
}) {
  const { state, update } = useMobileSpaces();
  const threads = useThreadShells();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [visible, setVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"spaces" | "projects" | "threads">("spaces");
  const [target, setTarget] = useState<AssignmentTarget | null>(null);
  const dotsRef = useRef<ScrollViewInstance>(null);
  const dotsViewportWidth = useRef(0);
  const dotsOffset = useRef(0);
  const activeDotIndex = state.spaces.findIndex((space) => space.id === state.activeSpaceId);
  const revealActiveDot = useCallback(() => {
    const width = dotsViewportWidth.current;
    if (activeDotIndex < 0 || width <= 0) return;
    const left = activeDotIndex * 44;
    const right = left + 44;
    const offset = dotsOffset.current;
    const next = left < offset ? left : right > offset + width ? right - width : offset;
    if (next === offset) return;
    dotsOffset.current = next;
    dotsRef.current?.scrollTo({ x: next, animated: false });
  }, [activeDotIndex]);
  useEffect(revealActiveDot, [revealActiveDot]);
  const active = state.spaces.find((space) => space.id === state.activeSpaceId);
  const editing = state.spaces.find((space) => space.id === editingId);
  const open = () => {
    setVisible(true);
    setTab("projects");
    setEditingId(null);
    setName("");
    setTarget(null);
  };
  const switchSpace = (id: string | null) => {
    update((current) => selectSpace(current, id));
    setVisible(false);
    const recent = state.lastThreadBySpace[id ?? "all"];
    const thread =
      recent &&
      threads.find(
        (candidate) =>
          candidate.environmentId === recent.environmentId && candidate.id === recent.threadId,
      );
    if (
      thread &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      (id === null || resolveThreadSpace(state, thread) === id)
    ) {
      if (props.onSelectThread) props.onSelectThread(thread);
      else
        navigation.navigate("Thread", { environmentId: thread.environmentId, threadId: thread.id });
    } else {
      if (props.onEmptySpace) props.onEmptySpace();
      else navigation.navigate("Home");
    }
  };
  const assign = (id: string | null | undefined) => {
    if (!target) return;
    update((current) =>
      target.kind === "project"
        ? assignProjectSpace(current, target.ref, id ?? null)
        : assignThreadSpace(current, target.ref, id),
    );
    setTarget(null);
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const membershipItems: ReadonlyArray<{ key: string; label: string; target: AssignmentTarget }> =
    !visible || target || tab !== "threads"
      ? []
      : threads
          .filter(
            (thread) =>
              thread.archivedAt === null &&
              thread.deletedAt === null &&
              thread.title.toLocaleLowerCase().includes(normalizedQuery),
          )
          .map((thread) => {
            const spaceId = resolveThreadSpace(state, thread);
            return {
              key: scopedThreadKey(thread.environmentId, thread.id),
              label: `${thread.title || "Untitled thread"} · ${savedConnectionsById[thread.environmentId]?.environmentLabel ?? thread.environmentId} · ${state.spaces.find((space) => space.id === spaceId)?.name ?? "No Space"}`,
              target: {
                kind: "thread" as const,
                ref: { environmentId: thread.environmentId, threadId: thread.id },
                title: thread.title,
              },
            };
          });
  const selectedMembership =
    target?.kind === "project"
      ? resolveProjectSpace(state, target.ref)
      : target
        ? state.threadSpaces[scopedThreadKey(target.ref.environmentId, target.ref.threadId)]
        : undefined;

  return (
    <>
      {props.settings ? (
        <SettingsRow
          icon="square.grid.2x2"
          label="Spaces"
          value={active?.name ?? "All Spaces"}
          onPress={open}
        />
      ) : (
        <View
          className="flex-row items-center justify-center bg-drawer px-2"
          style={{ paddingBottom: insets.bottom }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="All Spaces"
            accessibilityState={{ selected: state.activeSpaceId === null }}
            onPress={() => switchSpace(null)}
            className="min-h-11 min-w-11 items-center justify-center"
          >
            <SymbolView
              name="square.grid.2x2"
              size={18}
              tintColorClassName={
                state.activeSpaceId === null ? "accent-icon" : "accent-foreground-muted"
              }
            />
          </Pressable>
          <ScrollView
            ref={dotsRef}
            onLayout={(event) => {
              dotsViewportWidth.current = event.nativeEvent.layout.width;
              revealActiveDot();
            }}
            onScroll={(event) => {
              dotsOffset.current = event.nativeEvent.contentOffset.x;
            }}
            scrollEventThrottle={16}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="flex-grow items-center justify-center"
          >
            {state.spaces.map((space, index) => (
              <Pressable
                key={space.id}
                accessibilityRole="button"
                accessibilityLabel={`Switch to ${space.name}${index < 9 ? `, Control ${index + 1}` : ""}`}
                accessibilityState={{ selected: state.activeSpaceId === space.id }}
                onPress={() => switchSpace(space.id)}
                className="min-h-11 min-w-11 items-center justify-center"
              >
                <View
                  className={
                    state.activeSpaceId === space.id
                      ? "size-2.5 rounded-full bg-primary"
                      : "size-2 rounded-full bg-foreground-muted"
                  }
                />
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Spaces overview"
            onPress={open}
            className="min-h-11 min-w-11 items-center justify-center"
          >
            <SymbolView name="square.split.2x1" size={19} tintColorClassName="accent-icon" />
          </Pressable>
        </View>
      )}
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setVisible(false)}
      >
        <View
          className="flex-1 bg-sheet px-5"
          style={{
            paddingTop: Math.max(insets.top, 24),
            paddingBottom: Math.max(insets.bottom, 20),
          }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-xl font-t3-medium text-foreground">Spaces</Text>
            <Action label="Done" onPress={() => setVisible(false)} />
          </View>
          <View className="flex-row">
            {(["spaces", "projects", "threads"] as const).map((item) => (
              <Action
                key={item}
                label={item === "spaces" ? "Manage" : item === "projects" ? "Overview" : "Threads"}
                selected={tab === item}
                onPress={() => {
                  setTab(item);
                  setTarget(null);
                  setEditingId(null);
                  setName("");
                }}
              />
            ))}
          </View>
          {!target && tab === "projects" ? (
            <SpaceProjectsOverview
              onOpenSpace={switchSpace}
              onEditSpace={(id) => {
                const space = state.spaces.find((candidate) => candidate.id === id);
                if (!space) return;
                setTab("spaces");
                setEditingId(id);
                setName(space.name);
              }}
              onMoveProject={(project) =>
                setTarget({
                  kind: "project",
                  ref: { environmentId: project.environmentId, projectId: project.id },
                  title: project.title,
                })
              }
            />
          ) : !target && tab === "threads" ? (
            <FlatList
              data={membershipItems}
              keyExtractor={(item) => item.key}
              renderItem={({ item }) => (
                <Action label={item.label} onPress={() => setTarget(item.target)} />
              )}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
                <TextInput
                  accessibilityLabel={`Search ${tab}`}
                  value={query}
                  onChangeText={setQuery}
                  placeholder={`Search ${tab}`}
                  className="min-h-11 rounded-xl bg-grouped-card px-3 text-foreground"
                />
              }
              ListEmptyComponent={
                <Text className="py-3 text-foreground-muted">No matching {tab}</Text>
              }
            />
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              {target ? (
                <>
                  <Text className="py-3 text-foreground-muted">Space for {target.title}</Text>
                  {target.kind === "thread" ? (
                    <Action
                      label="Inherit from project"
                      selected={selectedMembership === undefined}
                      onPress={() => assign(undefined)}
                    />
                  ) : null}
                  <Action
                    label="No Space"
                    selected={selectedMembership === null}
                    onPress={() => assign(null)}
                  />
                  {state.spaces.map((space) => (
                    <Action
                      key={space.id}
                      label={space.name}
                      selected={selectedMembership === space.id}
                      onPress={() => assign(space.id)}
                    />
                  ))}
                  <Action label="Back" onPress={() => setTarget(null)} />
                </>
              ) : tab === "spaces" ? (
                <>
                  <Action
                    label="All Spaces"
                    selected={state.activeSpaceId === null}
                    onPress={() => switchSpace(null)}
                  />
                  {state.spaces.map((space) => (
                    <View key={space.id} className="flex-row items-center">
                      <View className="flex-1">
                        <Action
                          label={space.name}
                          selected={state.activeSpaceId === space.id}
                          onPress={() => switchSpace(space.id)}
                        />
                      </View>
                      <Action
                        label="Edit"
                        onPress={() => {
                          setEditingId(space.id);
                          setName(space.name);
                        }}
                      />
                    </View>
                  ))}
                  <TextInput
                    accessibilityLabel={editing ? "Space name" : "New Space name"}
                    value={name}
                    onChangeText={setName}
                    placeholder={editing ? "Space name" : "New Space name"}
                    className="min-h-11 rounded-xl bg-grouped-card px-3 text-foreground"
                  />
                  <Action
                    label={editing ? "Save name" : "Create Space"}
                    onPress={() => {
                      if (!name.trim()) return;
                      const id = editing?.id ?? uuidv4();
                      update((current) =>
                        editing
                          ? updateSpace(current, id, { name })
                          : createSpace(current, { id, name, theme: null }),
                      );
                      setName("");
                      setEditingId(null);
                    }}
                  />
                  {editing ? (
                    <>
                      <Text className="py-3 text-foreground-muted">Theme</Text>
                      <Action
                        label="Use app theme"
                        selected={editing.theme === null}
                        onPress={() =>
                          update((current) => updateSpace(current, editing.id, { theme: null }))
                        }
                      />
                      {MOBILE_THEME_OPTIONS.map((theme) => (
                        <Action
                          key={theme.id}
                          label={theme.label}
                          selected={editing.theme === theme.id}
                          onPress={() =>
                            update((current) =>
                              updateSpace(current, editing.id, { theme: theme.id }),
                            )
                          }
                        />
                      ))}
                      <Action
                        label="Delete Space"
                        onPress={() =>
                          Alert.alert(
                            "Delete Space?",
                            "Projects and threads will stay available in All Spaces.",
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Delete",
                                style: "destructive",
                                onPress: () => {
                                  update((current) => removeSpace(current, editing.id));
                                  setEditingId(null);
                                  setName("");
                                },
                              },
                            ],
                          )
                        }
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </ScrollView>
          )}
        </View>
      </Modal>
    </>
  );
}

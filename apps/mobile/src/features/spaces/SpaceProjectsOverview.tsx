import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { getMobileThemeRuntimeVariables } from "../../lib/mobileThemeVariables";
import { normalizeMobileThemeId } from "../../lib/mobileTheme";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { assignProjectSpace, resolveProjectSpace } from "@t3tools/client-runtime/state/spaces";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useProjects } from "../../state/entities";
import { useMobileSpaces } from "../../state/spaces";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { spaceProjectDropTarget, type SpaceColumnBounds } from "./spaceProjectDropTarget";

type Point = { absoluteX: number; absoluteY: number; x: number; y: number };
const COLUMN_WIDTH = 260;

function ProjectCard(props: {
  project: EnvironmentProject;
  environment: string;
  lifted: boolean;
  onMoveMenu: () => void;
  onStart: (point: Point) => void;
  onMove: (point: Point) => void;
  onEnd: (point: Point, success: boolean) => void;
}) {
  // Gesture callbacks fire outside render, so effect events give them the
  // latest props while the gesture object itself stays stable.
  const onStart = useEffectEvent((point: Point) => props.onStart(point));
  const onMove = useEffectEvent((point: Point) => props.onMove(point));
  const onEnd = useEffectEvent((point: Point, success: boolean) => props.onEnd(point, success));
  const [gesture] = useState(() =>
    Gesture.Pan()
      .activateAfterLongPress(300)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart((event) => onStart(event))
      .onUpdate((event) => onMove(event))
      .onFinalize((event, success) => onEnd(event, success)),
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        className="mb-2 rounded-2xl bg-grouped-card p-3"
        style={{ opacity: props.lifted ? 0.25 : 1 }}
      >
        <View className="flex-row items-center gap-2">
          <SymbolView name="folder" size={18} tintColorClassName="accent-icon" />
          <Text className="flex-1 text-sm font-t3-medium text-foreground" numberOfLines={2}>
            {props.project.title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Move ${props.project.title} to a Space`}
            onPress={props.onMoveMenu}
            className="min-h-11 min-w-11 items-center justify-center"
          >
            <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" />
          </Pressable>
        </View>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.environment}
        </Text>
      </View>
    </GestureDetector>
  );
}

export function SpaceProjectsOverview(props: {
  readonly onOpenSpace: (id: string | null) => void;
  readonly onEditSpace: (id: string) => void;
  readonly onMoveProject: (project: EnvironmentProject) => void;
}) {
  const { state, update } = useMobileSpaces();
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [dragging, setDragging] = useState<EnvironmentProject | null>(null);
  const [destination, setDestination] = useState<string | null | undefined>(undefined);
  const viewportRef = useRef<ViewInstance>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollOffset = useRef(0);
  const measuredScrollOffset = useRef(0);
  const contentWidth = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const previousFrameTime = useRef(0);
  const pointer = useRef<Point | null>(null);
  const columnViews = useRef(new Map<string | null, ViewInstance>());
  const measured = useRef<SpaceColumnBounds[]>([]);
  const measurementVersion = useRef(0);
  const viewport = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const drag = useRef<{
    project: EnvironmentProject;
    source: string | null;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  useEffect(
    () => () => {
      measurementVersion.current += 1;
      drag.current = null;
      pointer.current = null;
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    },
    [],
  );
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const overlayStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));
  const columns = [...state.spaces, { id: null, name: "No Space", theme: null }];
  const environmentLabel = (project: EnvironmentProject) =>
    savedConnectionsById[project.environmentId]?.environmentLabel ?? project.environmentId;
  const move = (point: Point) => {
    const active = drag.current;
    if (!active) return;
    pointer.current = point;
    x.set(point.absoluteX - viewport.current.x - active.offsetX);
    y.set(point.absoluteY - viewport.current.y - active.offsetY);
    const next = spaceProjectDropTarget(
      measured.current,
      viewport.current,
      point.absoluteX,
      point.absoluteY,
      scrollOffset.current - measuredScrollOffset.current,
    );
    setDestination((current) => (current === next ? current : next));
    const bounds = viewport.current;
    const localX = point.absoluteX - bounds.x;
    const nearEdge =
      bounds.width > 0 &&
      localX >= 0 &&
      localX < bounds.width &&
      point.absoluteY >= bounds.y &&
      point.absoluteY < bounds.y + bounds.height &&
      (localX < 40 || localX > bounds.width - 40);
    if (!nearEdge && scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    } else if (
      nearEdge &&
      measured.current.length === columnViews.current.size &&
      scrollFrame.current === null
    ) {
      previousFrameTime.current = 0;
      scrollFrame.current = requestAnimationFrame(scrollAtEdge);
    }
  };
  function scrollAtEdge(timestamp: number) {
    scrollFrame.current = null;
    const point = pointer.current;
    const bounds = viewport.current;
    if (
      !drag.current ||
      !point ||
      bounds.width <= 0 ||
      point.absoluteY < bounds.y ||
      point.absoluteY >= bounds.y + bounds.height
    )
      return;
    const localX = point.absoluteX - bounds.x;
    if (localX < 0 || localX >= bounds.width) return;
    const direction = localX < 40 ? -1 : localX > bounds.width - 40 ? 1 : 0;
    if (direction === 0) return;
    const elapsed =
      previousFrameTime.current === 0 ? 16 : Math.min(timestamp - previousFrameTime.current, 32);
    previousFrameTime.current = timestamp;
    const next = Math.max(
      0,
      Math.min(
        Math.max(0, contentWidth.current - bounds.width),
        scrollOffset.current + (direction * 600 * elapsed) / 1000,
      ),
    );
    if (next === scrollOffset.current) return;
    scrollOffset.current = next;
    scrollRef.current?.scrollTo({ x: next, animated: false });
    const target = spaceProjectDropTarget(
      measured.current,
      bounds,
      point.absoluteX,
      point.absoluteY,
      next - measuredScrollOffset.current,
    );
    setDestination((current) => (current === target ? current : target));
    scrollFrame.current = requestAnimationFrame(scrollAtEdge);
  }
  const start = (project: EnvironmentProject, point: Point) => {
    const version = ++measurementVersion.current;
    measuredScrollOffset.current = scrollOffset.current;
    measured.current = [];
    viewportRef.current?.measureInWindow((pageX, pageY, width, height) => {
      if (version !== measurementVersion.current) return;
      viewport.current = { x: pageX, y: pageY, width, height };
      move(point);
    });
    columnViews.current.forEach((view, spaceId) =>
      view.measureInWindow((pageX, pageY, width, height) => {
        if (version !== measurementVersion.current) return;
        measured.current.push({ spaceId, x: pageX, y: pageY, width, height });
        if (pointer.current) move(pointer.current);
      }),
    );
    drag.current = {
      project,
      source: resolveProjectSpace(state, {
        environmentId: project.environmentId,
        projectId: project.id,
      }),
      offsetX: point.x,
      offsetY: point.y,
    };
    setDragging(project);
    move(point);
  };
  const end = (point: Point, success: boolean) => {
    const active = drag.current;
    if (!active) return;
    const target = spaceProjectDropTarget(
      measured.current,
      viewport.current,
      point.absoluteX,
      point.absoluteY,
      scrollOffset.current - measuredScrollOffset.current,
    );
    if (success && target !== undefined && target !== active.source) {
      const ref = { environmentId: active.project.environmentId, projectId: active.project.id };
      update((current) => assignProjectSpace(current, ref, target));
    }
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    pointer.current = null;
    measurementVersion.current += 1;
    drag.current = null;
    setDragging(null);
    setDestination(undefined);
  };
  return (
    <GestureHandlerRootView className="flex-1">
      <Text className="pb-3 text-xs text-foreground-muted">
        Hold a project to drag it between Spaces. Use its menu to move it without dragging.
      </Text>
      <View ref={viewportRef} collapsable={false} className="flex-1">
        <ScrollView
          ref={scrollRef}
          onContentSizeChange={(width) => {
            contentWidth.current = width;
          }}
          onScroll={(event) => {
            if (!drag.current) scrollOffset.current = event.nativeEvent.contentOffset.x;
          }}
          scrollEventThrottle={16}
          horizontal
          scrollEnabled={dragging === null}
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-3 pb-2"
        >
          {columns.map((space) => {
            const members = projects.filter(
              (project) =>
                resolveProjectSpace(state, {
                  environmentId: project.environmentId,
                  projectId: project.id,
                }) === space.id,
            );
            const palette = space.theme
              ? getMobileThemeRuntimeVariables(
                  normalizeMobileThemeId(space.theme),
                  themeAppearance,
                  Platform.OS,
                )
              : themeVariables;
            return (
              <View
                key={space.id ?? "unassigned"}
                ref={(view) => {
                  if (view) columnViews.current.set(space.id, view);
                  else columnViews.current.delete(space.id);
                }}
                collapsable={false}
                className={
                  destination === space.id
                    ? "rounded-3xl border-2 border-primary bg-subtle p-3"
                    : "rounded-3xl border border-border-subtle bg-subtle p-3"
                }
                style={{ width: COLUMN_WIDTH, backgroundColor: palette["--color-drawer"] }}
              >
                <View className="mb-4 flex-row items-center">
                  {space.id === null ? (
                    <View className="min-h-11 flex-1 justify-center">
                      <Text
                        className="text-lg font-t3-medium text-foreground"
                        style={{ color: palette["--color-drawer-foreground"] }}
                      >
                        {space.name}
                      </Text>
                      <Text
                        className="text-xs text-foreground-muted"
                        style={{ color: palette["--color-drawer-foreground-muted"] }}
                      >
                        {members.length} {members.length === 1 ? "project" : "projects"}
                      </Text>
                    </View>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${space.name}`}
                      onPress={() => props.onOpenSpace(space.id)}
                      className="min-h-11 flex-1 justify-center"
                    >
                      <Text
                        className="text-lg font-t3-medium text-foreground"
                        style={{ color: palette["--color-drawer-foreground"] }}
                      >
                        {space.name}
                      </Text>
                      <Text
                        className="text-xs text-foreground-muted"
                        style={{ color: palette["--color-drawer-foreground-muted"] }}
                      >
                        {members.length} {members.length === 1 ? "project" : "projects"}
                      </Text>
                    </Pressable>
                  )}
                  {space.id !== null ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${space.name}`}
                      onPress={() => {
                        if (space.id !== null) props.onEditSpace(space.id);
                      }}
                      className="min-h-11 min-w-11 items-center justify-center"
                    >
                      <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon" />
                    </Pressable>
                  ) : null}
                </View>
                <FlatList
                  data={members}
                  keyExtractor={(project) => scopedProjectKey(project.environmentId, project.id)}
                  scrollEnabled={dragging === null}
                  renderItem={({ item }) => (
                    <ProjectCard
                      project={item}
                      environment={environmentLabel(item)}
                      lifted={
                        dragging?.environmentId === item.environmentId && dragging?.id === item.id
                      }
                      onMoveMenu={() => props.onMoveProject(item)}
                      onStart={(point) => start(item, point)}
                      onMove={move}
                      onEnd={end}
                    />
                  )}
                  ListEmptyComponent={
                    <Text
                      className="py-8 text-sm text-foreground-muted"
                      style={{ color: palette["--color-drawer-foreground-muted"] }}
                    >
                      Drop a project here
                    </Text>
                  }
                />
              </View>
            );
          })}
        </ScrollView>
        {dragging ? (
          <Animated.View
            pointerEvents="none"
            className="absolute top-0 left-0 rounded-2xl border border-primary bg-grouped-card p-4"
            style={[{ width: COLUMN_WIDTH - 24, zIndex: 10 }, overlayStyle]}
          >
            <Text className="text-sm font-t3-medium text-foreground">{dragging.title}</Text>
            <Text className="mt-1 text-xs text-foreground-muted">{environmentLabel(dragging)}</Text>
          </Animated.View>
        ) : null}
      </View>
    </GestureHandlerRootView>
  );
}

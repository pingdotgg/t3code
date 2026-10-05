import { useAtomValue } from "@effect/atom-react";
import {
  type ConnectionRoute,
  connectionRouteAddress,
  connectionRouteId,
  connectionRouteLabel,
  connectionRoutes,
  isLearned,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const ROW_HEIGHT = 64;

/**
 * The ways this device reaches an environment, preferred first. The first
 * route that answers is used, and the connection moves back up the list when
 * a better route is reachable again. Edit shows drag handles and remove
 * buttons; Add route pairs this machine over another address.
 */
export function EnvironmentRoutesSection({
  environmentId,
  connected,
  onAddRoute,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly onAddRoute: () => void;
}) {
  const entry = useAtomValue(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  const prepared = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const reorder = useAtomCommand(environmentCatalog.reorderRoutes, "route reorder");
  const removeRoute = useAtomCommand(environmentCatalog.removeRoute, "route removal");
  const [editing, setEditing] = useState(false);
  const saved = entry === undefined ? [] : connectionRoutes(entry);
  const savedIds = saved.map((route) => connectionRouteId(route.target));
  // A dropped order shows until the catalog matches it.
  const [pending, setPending] = useState<ReadonlyArray<string> | null>(null);
  const order =
    pending !== null &&
    pending.length === savedIds.length &&
    pending.some((id, index) => id !== savedIds[index])
      ? pending
      : savedIds;
  const [drag, setDrag] = useState<{ readonly id: string; readonly translation: number } | null>(
    null,
  );
  if (entry === undefined) return null;

  const byId = new Map(saved.map((route) => [connectionRouteId(route.target), route]));
  const routes = order.flatMap((id) => byId.get(id) ?? []);
  const activeRouteId =
    connected && Option.isSome(prepared) ? connectionRouteId(prepared.value.target) : null;

  const commit = (next: ReadonlyArray<string>) => {
    setPending(next);
    void reorder({ environmentId, routeIds: next }).then((result) => {
      if (result._tag === "Failure") setPending(null);
    });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    commit(next);
  };
  const dropIndex = (from: number, translation: number) =>
    Math.max(0, Math.min(order.length - 1, from + Math.round(translation / ROW_HEIGHT)));
  const confirmRemove = (route: ConnectionRoute) =>
    Alert.alert(
      `Remove ${connectionRouteLabel(route)}?`,
      connectionRouteAddress(route) ?? undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            void removeRoute({ environmentId, routeId: connectionRouteId(route.target) }),
        },
      ],
    );

  const dragFrom = drag === null ? -1 : order.indexOf(drag.id);
  const dragTo = drag === null ? -1 : dropIndex(dragFrom, drag.translation);

  return (
    <SettingsSection
      title="Routes"
      trailing={
        routes.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setEditing((value) => !value)}
            className="px-2 py-1 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-primary-text">
              {editing ? "Done" : "Edit"}
            </Text>
          </Pressable>
        ) : undefined
      }
    >
      {routes.map((route, index) => {
        const id = connectionRouteId(route.target);
        // Rows between the lifted row and its drop slot shift to make room.
        const shift =
          dragFrom === -1 || index === dragFrom
            ? 0
            : dragFrom < dragTo && index > dragFrom && index <= dragTo
              ? -ROW_HEIGHT
              : dragFrom > dragTo && index < dragFrom && index >= dragTo
                ? ROW_HEIGHT
                : 0;
        return (
          <RouteRow
            key={id}
            route={route}
            position={index + 1}
            count={routes.length}
            inUse={id === activeRouteId}
            editing={editing}
            offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
            lifted={index === dragFrom}
            onDragStart={() => setDrag({ id, translation: 0 })}
            onDragMove={(translation) => setDrag({ id, translation })}
            onDragEnd={(translation, cancelled) => {
              setDrag(null);
              if (!cancelled) move(index, dropIndex(index, translation));
            }}
            onStep={(direction) => move(index, direction === "up" ? index - 1 : index + 1)}
            // The last route goes with the machine, which is "Remove" on the row.
            // A learned route would be learned again, so it is only reordered.
            onRemove={
              routes.length > 1 && !isLearned(route) ? () => confirmRemove(route) : undefined
            }
          />
        );
      })}
      <Pressable
        accessibilityRole="button"
        onPress={onAddRoute}
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
      >
        <SymbolView name="plus" size={16} tintColorClassName="accent-icon" type="monochrome" />
        <Text className="text-base text-primary-text">Add route</Text>
      </Pressable>
    </SettingsSection>
  );
}

function RouteRow(props: {
  readonly route: ConnectionRoute;
  readonly position: number;
  readonly count: number;
  readonly inUse: boolean;
  readonly editing: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
  readonly onRemove: (() => void) | undefined;
}) {
  const { route, lifted, offset } = props;
  const label = connectionRouteLabel(route);
  const address = connectionRouteAddress(route);
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: lifted
          ? offset
          : withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System }),
      },
    ],
    zIndex: lifted ? 1 : 0,
  }));
  return (
    <Reanimated.View
      style={[{ height: ROW_HEIGHT }, style]}
      className={
        lifted ? "flex-row items-center bg-grouped-card shadow-md" : "flex-row items-center"
      }
    >
      {props.editing && props.onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label} route`}
          onPress={props.onRemove}
          className="h-full items-center justify-center pl-4 active:opacity-70"
        >
          <SymbolView
            name="xmark.circle.fill"
            size={20}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : null}
      <View
        accessible
        accessibilityLabel={[
          label,
          address,
          isLearned(route) ? "Found automatically" : null,
          props.inUse ? "In use" : null,
          `Route ${props.position} of ${props.count}`,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        className="min-w-0 flex-1 gap-0.5 px-4"
      >
        <View className="flex-row items-center gap-2">
          <Text className="text-base text-foreground">{label}</Text>
          {props.inUse ? (
            <Text className="text-xs font-t3-medium text-success-foreground">In use</Text>
          ) : null}
        </View>
        {address !== null ? (
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {isLearned(route) ? `${address} · found automatically` : address}
          </Text>
        ) : null}
      </View>
      {props.editing ? (
        <DragHandle
          title={label}
          canMoveUp={props.position > 1}
          canMoveDown={props.position < props.count}
          onStart={props.onDragStart}
          onMove={props.onDragMove}
          onEnd={props.onDragEnd}
          onStep={props.onStep}
        />
      ) : null}
    </Reanimated.View>
  );
}

/** Pan recognition wins over the settings scroll view only inside the handle. */
function DragHandle(props: {
  readonly title: string;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onStart: () => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
}) {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const translation = useRef(0);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(() => {
          translation.current = 0;
          latest.current.onStart();
        })
        .onUpdate((event) => {
          translation.current = event.translationY;
          latest.current.onMove(event.translationY);
        })
        .onFinalize((_, success) => latest.current.onEnd(translation.current, !success)),
    [],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${props.title}`}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        style={{ width: 48, height: ROW_HEIGHT, alignItems: "center", justifyContent: "center" }}
      >
        <SymbolView
          name="line.3.horizontal"
          size={20}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}

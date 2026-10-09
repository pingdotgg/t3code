import { useAtomValue } from "@effect/atom-react";
import {
  type ConnectionRoute,
  type ConnectionRouteKind,
  connectionRouteAddress,
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  connectionRoutes,
  isLearned,
} from "@t3tools/client-runtime/connection";
import { type EnvironmentId, sessionGrantsScope } from "@t3tools/contracts";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/cn";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectionTone } from "../connection/connectionTone";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

const ICON_SIZE = Platform.OS === "android" ? 24 : 22;
const REMOVE_SIZE = 20;

const ROUTE_ICONS: Record<ConnectionRouteKind, AppSymbolName> = {
  relay: "cloud",
  loopback: "desktopcomputer",
  lan: "wifi",
  tailnet: "point.3.connected.trianglepath.dotted",
  public: "globe",
  ssh: "terminal",
};

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
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const session = Option.getOrNull(AsyncResult.value(sessionResult));
  const [permissionsOpen, setPermissionsOpen] = useState(false);
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
  // Rows size to their content, so a drag measures how far it has moved past each one.
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  // Each drop remounts the rows so the new order and the cleared drag offsets
  // land in one frame. Kept rows would show their old offsets in their new
  // slots until the animated style catches up, and the card flashes empty.
  const [drops, setDrops] = useState(0);
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
  // A lifted row takes a neighbour's slot once it has moved past half of that row.
  const dropIndex = (from: number, translation: number) => {
    const step = translation > 0 ? 1 : -1;
    let to = from;
    let remaining = Math.abs(translation);
    while (to + step >= 0 && to + step < order.length) {
      const next = heights.get(order[to + step]!) ?? 0;
      if (next === 0 || remaining < next / 2) break;
      remaining -= next;
      to += step;
    }
    return to;
  };
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
            <Text className="text-sm font-t3-medium text-foreground android:text-primary-text">
              {editing ? "Done" : "Edit"}
            </Text>
          </Pressable>
        ) : undefined
      }
    >
      <SettingsActionRow
        icon="checkmark.circle"
        label="Your permissions"
        onPress={() => setPermissionsOpen((open) => !open)}
      />
      {permissionsOpen ? (
        <View className="gap-2 px-4 py-3">
          {activeRouteId !== null &&
          sessionResult._tag !== "Failure" &&
          !sessionResult.waiting &&
          session?.authenticated ? (
            <>
              <Text className="text-sm text-foreground-muted">
                Applies to the route marked In use. Other routes may have different permissions and
                have not been checked.
              </Text>
              {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => (
                <Text key={scope} className="text-sm text-foreground">
                  {title}: {sessionGrantsScope(session, scope) ? "Allowed" : "Not granted"}
                </Text>
              ))}
            </>
          ) : (
            <Text className="text-sm text-foreground-muted">
              Permissions not checked. Connect to this environment to view this session’s
              permissions.
            </Text>
          )}
        </View>
      ) : null}
      {routes.map((route, index) => {
        const id = connectionRouteId(route.target);
        // Rows between the lifted row and its drop slot shift to make room.
        const lifted = drag === null ? 0 : (heights.get(drag.id) ?? 0);
        const shift =
          dragFrom === -1 || index === dragFrom
            ? 0
            : dragFrom < dragTo && index > dragFrom && index <= dragTo
              ? -lifted
              : dragFrom > dragTo && index < dragFrom && index >= dragTo
                ? lifted
                : 0;
        return (
          <RouteRow
            key={`${id}:${drops}`}
            route={route}
            position={index + 1}
            count={routes.length}
            inUse={id === activeRouteId}
            editing={editing}
            offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
            lifted={index === dragFrom}
            onHeight={(height) =>
              setHeights((current) =>
                current.get(id) === height ? current : new Map(current).set(id, height),
              )
            }
            onDragStart={() => setDrag({ id, translation: 0 })}
            onDragMove={(translation) => setDrag({ id, translation })}
            onDragEnd={(translation, cancelled) => {
              setDrag(null);
              setDrops((count) => count + 1);
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
      <SettingsActionRow icon="plus" label="Add route" onPress={onAddRoute} />
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
  readonly onHeight: (height: number) => void;
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
      style={style}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
      className={cn("flex-row items-center gap-4 pl-4", lifted && "bg-grouped-card shadow-md")}
    >
      {props.editing && props.onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label} route`}
          hitSlop={8}
          onPress={props.onRemove}
          className="active:opacity-70"
        >
          <SymbolView
            name="xmark.circle.fill"
            size={REMOVE_SIZE}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : props.editing ? (
        <View style={{ width: REMOVE_SIZE }} />
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
        // Matches the padding of the settings rows around it.
        className={cn(
          "min-w-0 flex-1 flex-row items-center gap-4 py-4 android:py-3",
          address !== null ? "android:min-h-18" : "android:min-h-14",
          !props.editing && "pr-4",
        )}
      >
        <SymbolView
          name={ROUTE_ICONS[connectionRouteKind(route)]}
          size={ICON_SIZE}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1 gap-0.5 android:gap-1">
          <View className="flex-row items-center gap-2">
            <Text numberOfLines={1} className="shrink text-lg text-foreground android:text-base">
              {label}
            </Text>
            {props.inUse ? (
              <StatusPill {...connectionTone("connected")} label="In use" size="compact" />
            ) : null}
          </View>
          {address !== null ? (
            <Text numberOfLines={1} className="text-sm text-foreground-muted">
              {isLearned(route) ? `${address} · found automatically` : address}
            </Text>
          ) : null}
        </View>
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
        style={{ width: 48, alignSelf: "stretch", alignItems: "center", justifyContent: "center" }}
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

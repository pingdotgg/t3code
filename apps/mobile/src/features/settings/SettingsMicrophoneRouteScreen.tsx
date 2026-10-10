import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Pressable, ScrollView, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { MicrophoneKind, RememberedMicrophone } from "../../lib/microphonePriority";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { SettingsSection } from "./components/SettingsSection";

const REMOVE_SIZE = 20;

type MicrophonePermission = "checking" | "granted" | "ask" | "denied";

/** Re-reads microphone access whenever the app returns from system Settings. */
function useMicrophonePermission() {
  const [permission, setPermission] = useState<MicrophonePermission>("checking");
  const apply = useCallback(
    (response: { readonly granted: boolean; readonly canAskAgain: boolean }) =>
      setPermission(response.granted ? "granted" : response.canAskAgain ? "ask" : "denied"),
    [],
  );
  const refresh = useCallback(
    () => void getRecordingPermissionsAsync().then(apply, () => setPermission("ask")),
    [apply],
  );
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  const request = useCallback(
    () => void requestRecordingPermissionsAsync().then(apply, refresh),
    [apply, refresh],
  );
  return { permission, request };
}

const KINDS: Record<MicrophoneKind, { readonly label: string; readonly icon: AppSymbolName }> = {
  wired: { label: "Wired", icon: "cable.connector" },
  bluetooth: { label: "Bluetooth", icon: "headphones" },
  builtIn: { label: "Built-in", icon: "iphone" },
  carPlay: { label: "CarPlay", icon: "car" },
};

/**
 * Microphones voice input has seen, in the order it prefers them. iOS only.
 * A microphone joins the list the first time it is connected during dictation.
 */
export function SettingsMicrophoneRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const microphones = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.microphones ?? [])
    : [];
  const { permission, request: requestPermission } = useMicrophonePermission();
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<{ readonly uid: string; readonly translation: number } | null>(
    null,
  );
  const [rowHeight, setRowHeight] = useState(0);
  // Each drop remounts the rows so the new order and the cleared offsets land in one frame.
  const [drops, setDrops] = useState(0);

  // Transforms apply to the stored list, so a microphone recorded meanwhile is kept.
  const move = (uid: string, steps: number) =>
    savePreferences({
      transform: (current) => {
        const next = [...(current.microphones ?? [])];
        const from = next.findIndex((microphone) => microphone.uid === uid);
        const to = Math.min(next.length - 1, Math.max(0, from + steps));
        if (from === -1 || from === to) return {};
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return { microphones: next };
      },
    });
  const forget = (uid: string) =>
    savePreferences({
      transform: (current) => ({
        microphones: (current.microphones ?? []).filter((microphone) => microphone.uid !== uid),
      }),
    });
  // A lifted row takes a neighbour's slot once it has moved past half of that row.
  const dropSteps = (from: number, translation: number) =>
    rowHeight === 0
      ? 0
      : Math.min(microphones.length - 1, Math.max(0, from + Math.round(translation / rowHeight))) -
        from;

  const dragFrom =
    drag === null ? -1 : microphones.findIndex((microphone) => microphone.uid === drag.uid);
  const dragTo = drag === null ? -1 : dragFrom + dropSteps(dragFrom, drag.translation);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {permission === "ask" || permission === "denied" ? (
          <>
            <SettingsSection title="Microphone access">
              <SettingsActionRow
                icon="mic"
                label={permission === "ask" ? "Allow microphone access" : "Open Settings"}
                onPress={
                  permission === "ask" ? requestPermission : () => void Linking.openSettings()
                }
              />
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              {permission === "ask"
                ? "Voice input needs microphone access before it can record or list your microphones."
                : "Microphone access is off for T3 Code. Turn it on in Settings to use voice input."}
            </Text>
          </>
        ) : null}
        {microphones.length === 0 ? (
          permission === "granted" && ready ? (
            <Text className="px-2 text-sm text-foreground-muted">
              Microphones appear here after you use voice input with them connected.
            </Text>
          ) : null
        ) : (
          <>
            <SettingsSection
              title="Preferred order"
              trailing={
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setEditing((value) => !value)}
                  className="px-2 py-1 active:opacity-70"
                >
                  <Text className="text-sm font-t3-medium text-foreground">
                    {editing ? "Done" : "Edit"}
                  </Text>
                </Pressable>
              }
            >
              {microphones.map((microphone, index) => {
                const shift =
                  dragFrom === -1 || index === dragFrom
                    ? 0
                    : dragFrom < dragTo && index > dragFrom && index <= dragTo
                      ? -rowHeight
                      : dragFrom > dragTo && index < dragFrom && index >= dragTo
                        ? rowHeight
                        : 0;
                return (
                  <MicrophoneRow
                    key={`${microphone.uid}:${drops}`}
                    microphone={microphone}
                    position={index + 1}
                    count={microphones.length}
                    reorderable={ready && microphones.length > 1}
                    editing={editing}
                    offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
                    lifted={index === dragFrom}
                    onHeight={setRowHeight}
                    onDragStart={() => setDrag({ uid: microphone.uid, translation: 0 })}
                    onDragMove={(translation) => setDrag({ uid: microphone.uid, translation })}
                    onDragEnd={(translation, cancelled) => {
                      setDrag(null);
                      setDrops((count) => count + 1);
                      if (!cancelled) move(microphone.uid, dropSteps(index, translation));
                    }}
                    onStep={(direction) => move(microphone.uid, direction === "up" ? -1 : 1)}
                    onForget={() => forget(microphone.uid)}
                  />
                );
              })}
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              Voice input records from the first connected microphone in this list. New microphones
              appear after you use voice input with them connected.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function MicrophoneRow(props: {
  readonly microphone: RememberedMicrophone;
  readonly position: number;
  readonly count: number;
  readonly reorderable: boolean;
  readonly editing: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
  readonly onForget: () => void;
}) {
  const { lifted, offset, microphone } = props;
  const kind = KINDS[microphone.kind];
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
      className={cn(
        "flex-row items-center gap-4 pl-4",
        props.position > 1 && !lifted && "border-t border-border-subtle",
        lifted && "bg-grouped-card shadow-md",
        !props.reorderable && "pr-4",
      )}
    >
      {props.editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Forget ${microphone.name}`}
          hitSlop={8}
          onPress={props.onForget}
          className="active:opacity-70"
        >
          <SymbolView
            name="xmark.circle.fill"
            size={REMOVE_SIZE}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : null}
      <View
        accessible
        accessibilityLabel={`${microphone.name}, ${kind.label}, ${props.position} of ${props.count}`}
        className="min-w-0 flex-1 flex-row items-center gap-4 py-4"
      >
        <SymbolView
          name={kind.icon}
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-lg text-foreground">
            {microphone.name}
          </Text>
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {kind.label}
          </Text>
        </View>
      </View>
      {props.reorderable ? (
        <SettingsDragHandle
          title={microphone.name}
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

import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { useState } from "react";
import { Linking, useWindowDimensions, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  isMicrophoneDevice,
  type MicrophoneEntry,
  type MicrophoneKind,
  microphoneEntryKey,
  microphoneOrder,
} from "../../lib/microphonePriority";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { SettingsSection } from "./components/SettingsSection";

type MicrophonePermission = "checking" | "granted" | "ask" | "denied";

function toMicrophonePermission(response: {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}): MicrophonePermission {
  return response.granted ? "granted" : response.canAskAgain ? "ask" : "denied";
}

const readMicrophonePermission = () =>
  getRecordingPermissionsAsync().then(toMicrophonePermission, (): MicrophonePermission => "ask");

const microphonePermissionAtom = makePermissionStatusAtom<MicrophonePermission>({
  label: "mobile:microphone-permission",
  initial: "checking",
  read: readMicrophonePermission,
});

function useMicrophonePermission() {
  const permission = useAtomValue(microphonePermissionAtom);
  const setPermission = useAtomSet(microphonePermissionAtom);
  const request = () =>
    void requestRecordingPermissionsAsync()
      .then(toMicrophonePermission, readMicrophonePermission)
      .then(setPermission);
  return { permission, request };
}

const KINDS: Record<
  MicrophoneKind,
  {
    readonly label: string;
    readonly row: string;
    readonly rowDescription: string;
    readonly icon: AppSymbolName;
  }
> = {
  wired: {
    label: "Wired",
    row: "Other wired",
    rowDescription: "Headsets and USB microphones not listed",
    icon: "cable.connector",
  },
  bluetooth: {
    label: "Bluetooth",
    row: "Other Bluetooth",
    rowDescription: "AirPods, headsets, and cars not listed",
    icon: "headphones",
  },
  builtIn: {
    label: "Built-in",
    row: "Built-in microphone",
    rowDescription: "The microphone on this device",
    icon: "iphone",
  },
  carPlay: {
    label: "CarPlay",
    row: "CarPlay",
    rowDescription: "The car’s microphone",
    icon: "car",
  },
};

export function SettingsMicrophoneRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const entries = microphoneOrder(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value.microphones : undefined,
  );
  const { permission, request: requestPermission } = useMicrophonePermission();
  const [drag, setDrag] = useState<{ readonly key: string; readonly translation: number } | null>(
    null,
  );
  const [rowHeight, setRowHeight] = useState(0);
  // Each drop remounts the rows so the new order and the cleared offsets land in one frame.
  const [drops, setDrops] = useState(0);

  // Transforms apply to the stored order, so a device recorded meanwhile is kept.
  const move = (key: string, steps: number) =>
    savePreferences({
      transform: (current) => {
        const next = [...microphoneOrder(current.microphones)];
        const from = next.findIndex((entry) => microphoneEntryKey(entry) === key);
        const to = Math.min(next.length - 1, Math.max(0, from + steps));
        if (from === -1 || from === to) return {};
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return { microphones: next };
      },
    });
  const forget = (key: string) =>
    savePreferences({
      transform: (current) => ({
        microphones: microphoneOrder(current.microphones).filter(
          (entry) => microphoneEntryKey(entry) !== key,
        ),
      }),
    });
  const dropSteps = (from: number, translation: number) =>
    rowHeight === 0
      ? 0
      : Math.min(entries.length - 1, Math.max(0, from + Math.round(translation / rowHeight))) -
        from;

  const dragFrom =
    drag === null ? -1 : entries.findIndex((entry) => microphoneEntryKey(entry) === drag.key);
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
        <SettingsSection title="Preferred order">
          {entries.map((entry, index) => {
            const key = microphoneEntryKey(entry);
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
                key={`${key}:${drops}`}
                entry={entry}
                position={index + 1}
                count={entries.length}
                reorderable={ready}
                offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
                lifted={index === dragFrom}
                onHeight={setRowHeight}
                onDragStart={() => setDrag({ key, translation: 0 })}
                onDragMove={(translation) => setDrag({ key, translation })}
                onDragEnd={(translation, cancelled) => {
                  setDrag(null);
                  setDrops((count) => count + 1);
                  if (!cancelled) move(key, dropSteps(index, translation));
                }}
                onStep={(direction) => move(key, direction === "up" ? -1 : 1)}
                onForget={isMicrophoneDevice(entry) ? () => forget(key) : undefined}
              />
            );
          })}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Voice input records from the first connected microphone in this list. Wired and Bluetooth
          devices are added by name after you use voice input with them connected; until then, the
          Other row ranks them. Swipe a device left to forget it.
        </Text>
      </ScrollView>
    </View>
  );
}

function MicrophoneRow(props: {
  readonly entry: MicrophoneEntry;
  readonly position: number;
  readonly count: number;
  readonly reorderable: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
  readonly onForget: (() => void) | undefined;
}) {
  const { lifted, offset, entry, onForget } = props;
  const kind = KINDS[entry.kind];
  const title = isMicrophoneDevice(entry) ? entry.name : kind.row;
  const { width: windowWidth } = useWindowDimensions();
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
  const row = (
    // Opaque so the swipe actions stay hidden until the row slides over them.
    <View className="flex-row items-center bg-grouped-card">
      <View
        accessible
        accessibilityLabel={`${title}, ${kind.label}, ${props.position} of ${props.count}`}
        accessibilityActions={onForget ? [{ name: "forget", label: "Forget" }] : undefined}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "forget") onForget?.();
        }}
        className="min-w-0 flex-1"
      >
        <ListRowLayout
          icon={kind.icon}
          label={title}
          description={isMicrophoneDevice(entry) ? kind.label : kind.rowDescription}
        />
      </View>
      {props.reorderable ? (
        <SettingsDragHandle
          title={title}
          canMoveUp={props.position > 1}
          canMoveDown={props.position < props.count}
          onStart={props.onDragStart}
          onMove={props.onDragMove}
          onEnd={props.onDragEnd}
          onStep={props.onStep}
        />
      ) : null}
    </View>
  );
  return (
    <Reanimated.View
      style={style}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
      className={cn(
        props.position > 1 && !lifted && "border-t border-border-subtle",
        lifted && "bg-grouped-card shadow-md",
      )}
    >
      {onForget ? (
        <ThreadSwipeable
          backgroundColor="transparent"
          fullSwipeAction="primary"
          fullSwipeWidth={windowWidth - 40}
          onDelete={onForget}
          primaryAction={{
            accessibilityLabel: `Forget ${title}`,
            destructive: true,
            icon: "trash",
            label: "Forget",
            onPress: onForget,
          }}
          secondaryAction={null}
          threadKey={`microphone:${microphoneEntryKey(entry)}`}
          threadTitle={title}
        >
          {() => row}
        </ThreadSwipeable>
      ) : (
        row
      )}
    </Reanimated.View>
  );
}

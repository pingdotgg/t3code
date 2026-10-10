import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { type MicrophoneKind, resolveMicrophonePriority } from "../../lib/microphonePriority";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { SettingsSection } from "./components/SettingsSection";

const MICROPHONES: Record<
  MicrophoneKind,
  { readonly label: string; readonly description: string; readonly icon: AppSymbolName }
> = {
  wired: {
    label: "Wired",
    description: "Headsets and USB microphones",
    icon: "cable.connector",
  },
  bluetooth: {
    label: "Bluetooth",
    description: "AirPods, headsets, and cars without CarPlay",
    icon: "airpods",
  },
  builtIn: {
    label: "iPhone",
    description: "The microphone on this device",
    icon: "iphone",
  },
  carPlay: {
    label: "CarPlay",
    description: "The car’s microphone",
    icon: "car",
  },
};

/** Voice input records from the first connected microphone in this order. iOS only. */
export function SettingsMicrophoneRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const order = resolveMicrophonePriority(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value.microphonePriority : [],
  );
  const [drag, setDrag] = useState<{
    readonly kind: MicrophoneKind;
    readonly translation: number;
  } | null>(null);
  const [rowHeight, setRowHeight] = useState(0);
  // Each drop remounts the rows so the new order and the cleared offsets land in one frame.
  const [drops, setDrops] = useState(0);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    savePreferences({ microphonePriority: next });
  };
  // A lifted row takes a neighbour's slot once it has moved past half of that row.
  const dropIndex = (from: number, translation: number) =>
    rowHeight === 0
      ? from
      : Math.min(order.length - 1, Math.max(0, from + Math.round(translation / rowHeight)));

  const dragFrom = drag === null ? -1 : order.indexOf(drag.kind);
  const dragTo = drag === null ? -1 : dropIndex(dragFrom, drag.translation);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Preferred order">
          {order.map((kind, index) => {
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
                key={`${kind}:${drops}`}
                kind={kind}
                position={index + 1}
                count={order.length}
                disabled={!ready}
                offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
                lifted={index === dragFrom}
                onHeight={setRowHeight}
                onDragStart={() => setDrag({ kind, translation: 0 })}
                onDragMove={(translation) => setDrag({ kind, translation })}
                onDragEnd={(translation, cancelled) => {
                  setDrag(null);
                  setDrops((count) => count + 1);
                  if (!cancelled) move(index, dropIndex(index, translation));
                }}
                onStep={(direction) => move(index, direction === "up" ? index - 1 : index + 1)}
              />
            );
          })}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Voice input records from the first connected microphone in this list. Drag to reorder.
        </Text>
      </ScrollView>
    </View>
  );
}

function MicrophoneRow(props: {
  readonly kind: MicrophoneKind;
  readonly position: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
}) {
  const { lifted, offset } = props;
  const microphone = MICROPHONES[props.kind];
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
      )}
    >
      <View
        accessible
        accessibilityLabel={`${microphone.label}, ${microphone.description}, ${props.position} of ${props.count}`}
        className="min-w-0 flex-1 flex-row items-center gap-4 py-4"
      >
        <SymbolView
          name={microphone.icon}
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-lg text-foreground">
            {microphone.label}
          </Text>
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {microphone.description}
          </Text>
        </View>
      </View>
      {props.disabled ? null : (
        <SettingsDragHandle
          title={microphone.label}
          canMoveUp={props.position > 1}
          canMoveDown={props.position < props.count}
          onStart={props.onDragStart}
          onMove={props.onDragMove}
          onEnd={props.onDragEnd}
          onStep={props.onStep}
        />
      )}
    </Reanimated.View>
  );
}

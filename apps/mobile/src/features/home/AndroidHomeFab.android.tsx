import { useCallback, useRef, useState, type ComponentProps } from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialNewThreadButton } from "../../components/MaterialNewThreadButton";
import type { AndroidHomeFabLayout as SharedAndroidHomeFabLayout } from "./AndroidHomeFab.shared";
import { useWorkspaceState } from "../../state/workspace";
import { MaterialFabScrollContext } from "./MaterialFabScrollContext";
import { updateMaterialFabScroll } from "./material-fab-scroll";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const insets = useSafeAreaInsets();
  const { state } = useWorkspaceState();
  const [expanded, setExpanded] = useState(true);
  const scrollState = useRef({ anchor: 0, expanded: true });
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const next = updateMaterialFabScroll(
      scrollState.current,
      contentOffset.y,
      contentSize.height - layoutMeasurement.height,
    );
    if (next.expanded !== scrollState.current.expanded) setExpanded(next.expanded);
    scrollState.current = next;
  }, []);

  return (
    <View className="flex-1">
      <MaterialFabScrollContext value={onScroll}>{props.children}</MaterialFabScrollContext>
      {state.hasConnections ? (
        <MaterialNewThreadButton
          extended
          expanded={expanded}
          onPress={props.onStartNewTask}
          className="absolute right-5"
          style={{
            bottom: props.sidebar
              ? Math.max(insets.bottom, 12) + 6
              : Math.max(insets.bottom, 16) + 16,
          }}
        />
      ) : null}
    </View>
  );
}

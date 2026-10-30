import { useSyncExternalStore, type ReactNode } from "react";
import { View } from "react-native";
import { Stack } from "react-native-screens";

import { V5StackHeader } from "../../native/V5StackHeader.ios";
import {
  InspectorBarScope,
  useInspectorBarStore,
  type InspectorBarStore,
} from "./inspector-bar-store";

/** The inspector's navigation bar, drawn from what its visible pane's AppBar set. */
export function InspectorBarHeader(props: { readonly store: InspectorBarStore }) {
  const options = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  return <V5StackHeader options={{ headerShown: false, ...options }} canGoBack={false} />;
}

/** Gives inspector content a navigation bar where no native inspector column draws one. */
export function InspectorBar(props: {
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const store = useInspectorBarStore();
  return (
    <InspectorBarScope store={store} onClose={props.onClose}>
      <Stack.Host>
        <Stack.Screen screenKey="inspector" activityMode="attached">
          <InspectorBarHeader store={store} />
          <View className="flex-1 bg-screen">{props.children}</View>
        </Stack.Screen>
      </Stack.Host>
    </InspectorBarScope>
  );
}

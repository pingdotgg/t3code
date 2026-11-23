import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * What stands where the composer would for a thread that takes no messages. `children` say what
 * the thread is and how it is doing, then any actions.
 */
export function ReadOnlyComposerBar(props: { readonly children: ReactNode }) {
  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      {props.children}
    </View>
  );
}

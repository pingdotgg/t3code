import { HeaderHeightContext } from "@react-navigation/elements";
import { useState, type ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { NativeColumnLayoutMetricsContext } from "./native-layout-metrics";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";
import { NativeLayoutObserver } from "./NativeLayoutObserver";

export function NativeColumnContent(props: {
  readonly children: ReactNode;
  readonly primary?: boolean;
  readonly insetTop?: boolean;
  readonly insetHorizontally?: boolean;
  readonly backgroundColor?: ColorValue;
}) {
  const [metrics, setMetrics] = useState<NativeLayoutMetrics | null>(null);
  return (
    <View className={props.primary ? "flex-1 bg-drawer" : "flex-1 bg-header"}>
      <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView
          edges={{
            top: props.insetTop === false ? "off" : "additive",
            left: props.insetHorizontally === false ? "off" : "additive",
            right: props.insetHorizontally === false ? "off" : "additive",
          }}
          style={{ flex: 1 }}
        >
          <View
            className={`flex-1 overflow-hidden ${props.primary ? "bg-drawer" : "bg-screen"} ${props.insetTop === false ? "" : "rounded-t-[28px]"}`}
            style={
              props.backgroundColor === undefined
                ? undefined
                : { backgroundColor: props.backgroundColor }
            }
          >
            {/* Descendants measure the inset body so they don't reserve the native bar twice. */}
            <SafeAreaProvider style={{ flex: 1 }}>
              <NativeLayoutObserver onChange={setMetrics} />
              <NativeColumnLayoutMetricsContext value={metrics}>
                <HeaderHeightContext value={metrics?.safeArea.top ?? undefined}>
                  {props.children}
                </HeaderHeightContext>
              </NativeColumnLayoutMetricsContext>
            </SafeAreaProvider>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </View>
  );
}

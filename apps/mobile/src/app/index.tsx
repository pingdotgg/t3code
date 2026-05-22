import { Stack, useRouter } from "expo-router";
import { type ComponentProps, useState } from "react";
import { Pressable, Text as RNText, View, useColorScheme } from "react-native";
import { SymbolView } from "expo-symbols";
import { useThemeColor } from "../lib/useThemeColor";

import { buildThreadRoutePath } from "../lib/routes";
import { useRemoteCatalog } from "../state/use-remote-catalog";
import { useRemoteEnvironmentState } from "../state/use-remote-environment-registry";
import { HomeScreen } from "../features/home/HomeScreen";
import type { RemoteCatalogState } from "../state/use-remote-catalog";

function resolveHeaderStatus(state: RemoteCatalogState): {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly color: string;
  readonly label: string;
} {
  if (state.isLoadingSavedConnections) {
    return { icon: "hourglass", color: "#737373", label: "Loading environments" };
  }
  if (state.connectionError) {
    return { icon: "exclamationmark.triangle.fill", color: "#ef4444", label: "Environment error" };
  }
  if (state.connectionState === "ready") {
    return { icon: "checkmark.circle.fill", color: "#22c55e", label: "Environment online" };
  }
  if (state.connectionState === "connecting" || state.connectionState === "reconnecting") {
    return {
      icon: "arrow.triangle.2.circlepath",
      color: "#f59e0b",
      label: "Environment connecting",
    };
  }
  return { icon: "wifi.slash", color: "#ef4444", label: "Environment offline" };
}

/* ─── Route screen ───────────────────────────────────────────────────── */

export default function HomeRouteScreen() {
  const { projects, state: catalogState, threads } = useRemoteCatalog();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  const isDark = useColorScheme() === "dark";
  const iconColor = String(useThemeColor("--color-icon"));
  const status = resolveHeaderStatus(catalogState);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          headerShadowVisible: false,
          headerTintColor: iconColor,
          headerTitle: "",
          headerSearchBarOptions: {
            placeholder: "Search threads",
            onChangeText: (event) => {
              setSearchQuery(event.nativeEvent.text);
            },
            allowToolbarIntegration: true,
          },
        }}
      />

      {/* Header left: plain text, no Liquid Glass button chrome */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <RNText
              style={{
                fontFamily: "DMSans_700Bold",
                fontSize: 17,
                color: iconColor,
                letterSpacing: -0.4,
              }}
            >
              T3 Code
            </RNText>
            <View
              style={{
                backgroundColor: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
                borderRadius: 99,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <RNText
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 10,
                  color: "#737373",
                  letterSpacing: 1.1,
                  textTransform: "uppercase",
                }}
              >
                Alpha
              </RNText>
            </View>
          </View>
        </Stack.Toolbar.View>
      </Stack.Toolbar>

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.View hidesSharedBackground>
          <Pressable
            accessibilityLabel={status.label}
            className="h-11 w-11 items-center justify-center rounded-full bg-card active:opacity-70"
            onPress={() => router.push("/connections")}
          >
            <SymbolView name={status.icon} size={21} tintColor={status.color} type="monochrome" />
          </Pressable>
        </Stack.Toolbar.View>
      </Stack.Toolbar>

      {/* Bottom toolbar: search + compose, visually split like iMessage */}
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.SearchBarSlot />
        <Stack.Toolbar.Spacer width={8} sharesBackground={false} />
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          onPress={() => router.push("/new")}
          separateBackground
        />
      </Stack.Toolbar>

      <HomeScreen
        projects={projects}
        threads={threads}
        catalogState={catalogState}
        savedConnectionsById={savedConnectionsById}
        searchQuery={searchQuery}
        onAddConnection={() => router.push("/connections/new")}
        onSelectThread={(thread) => {
          router.push(buildThreadRoutePath(thread));
        }}
      />
    </>
  );
}

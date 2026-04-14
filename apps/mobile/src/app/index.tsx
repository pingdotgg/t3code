import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text as RNText, View, useColorScheme } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import { buildThreadRoutePath } from "../lib/routes";
import { ConnectionStatusDot } from "../features/connection/ConnectionStatusDot";
import { useRemoteCatalog } from "../state/use-remote-catalog";
import { useRemoteEnvironmentState } from "../state/use-remote-environment-registry";
import { HomeScreen } from "../features/home/HomeScreen";
import { EnvironmentConnectionState } from "@t3tools/client-runtime";

/* ─── Connection pill label ──────────────────────────────────────────── */

const CONNECTION_LABEL: Record<EnvironmentConnectionState, string> = {
  ready: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Offline",
  idle: "No backends",
};

/* ─── Route screen ───────────────────────────────────────────────────── */

export default function HomeRouteScreen() {
  const { connectionState, hasRemoteActivity, projects, threads } = useRemoteCatalog();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  const isDark = useColorScheme() === "dark";
  const iconColor = String(useThemeColor("--color-icon"));
  const secondaryFg = isDark ? "#a3a3a3" : "#525252";

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
          headerRight: () => (
            <Pressable
              onPress={() => router.push("/connections")}
              hitSlop={8}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 4,
                paddingVertical: 4,
              }}
            >
              <ConnectionStatusDot state={connectionState} pulse={hasRemoteActivity} size={7} />
              <RNText
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 12,
                  color: secondaryFg,
                }}
              >
                {CONNECTION_LABEL[connectionState]}
              </RNText>
            </Pressable>
          ),
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
        savedConnectionsById={savedConnectionsById}
        searchQuery={searchQuery}
        onSelectThread={(thread) => {
          router.push(buildThreadRoutePath(thread));
        }}
      />
    </>
  );
}

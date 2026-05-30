import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Text as RNText, View, useColorScheme } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import { buildThreadRoutePath } from "../lib/routes";
import { useRemoteCatalog } from "../state/use-remote-catalog";
import { useRemoteEnvironmentState } from "../state/use-remote-environment-registry";
import { HomeScreen } from "../features/home/HomeScreen";

/* ─── Route screen ───────────────────────────────────────────────────── */

export default function HomeRouteScreen() {
  const { projects, state: catalogState, threads } = useRemoteCatalog();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  const isDark = useColorScheme() === "dark";
  const iconColor = String(useThemeColor("--color-icon"));

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
        <Stack.Toolbar.Menu icon="ellipsis.circle" separateBackground>
          <Stack.Toolbar.Label>More</Stack.Toolbar.Label>
          <Stack.Toolbar.MenuAction
            icon="desktopcomputer"
            onPress={() => router.push("/connections")}
            subtitle="Manage connected hosts"
          >
            <Stack.Toolbar.Label>Environments</Stack.Toolbar.Label>
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
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

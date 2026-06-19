import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Text as RNText, View } from "react-native";

import { useProjects, useThreadShells } from "../state/entities";
import { useWorkspaceState } from "../state/workspace";
import { buildThreadRoutePath } from "../lib/routes";
import { useSavedRemoteConnections } from "../state/use-remote-environment-registry";
import { HomeScreen } from "../features/home/HomeScreen";
import { useThemeColor } from "../lib/useThemeColor";

/* ─── Route screen ───────────────────────────────────────────────────── */

export default function HomeRouteScreen() {
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");

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
            hideNavigationBar: false,
            onChangeText: (event) => {
              setSearchQuery(event.nativeEvent.text);
            },
            onCancelButtonPress: () => {
              setSearchQuery("");
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
                backgroundColor: subtleColor,
                borderRadius: 99,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <RNText
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 10,
                  color: mutedColor,
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
        <Stack.Toolbar.Button
          icon="gearshape"
          onPress={() => router.push("/settings")}
          separateBackground
        />
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
        onOpenEnvironments={() => router.push("/settings/environments")}
        onSelectThread={(thread) => {
          router.push(buildThreadRoutePath(thread));
        }}
      />
    </>
  );
}

import { Toolbar } from "../../components/ui/Toolbar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsEnvironmentsRouteScreen } from "./SettingsEnvironmentsRouteScreen";
import { useSettingsSidebarActive } from "./settings-environment-filter";
import { useSettingsAccount, useSettingsNavigationGroups } from "./use-settings-navigation-groups";

export function SettingsRouteScreen() {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const sidebarActive = useSettingsSidebarActive();
  // The sidebar already lists the sections, so the index opens on the first one.
  if (sidebarActive) return <SettingsEnvironmentsRouteScreen />;
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsIndex />
  ) : (
    <SettingsIndex account={null} />
  );

  return (
    <>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions options={{ headerBackVisible: !layout.usesSplitView }} />
      ) : null}
      {Platform.OS === "ios" && layout.usesSplitView ? (
        <>
          <Toolbar placement="left">
            <Toolbar.Button
              accessibilityLabel="Go back"
              icon="chevron.left"
              onPress={() => navigation.goBack()}
            />
          </Toolbar>
        </>
      ) : null}
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen title="Settings" trailing={<AndroidSettingsEnvironmentFilter />}>
          {content}
        </SettingsScreen>
      ) : (
        content
      )}
    </>
  );
}

function ConfiguredSettingsIndex() {
  return <SettingsIndex account={useSettingsAccount()} />;
}

function SettingsIndex(props: {
  readonly account: Parameters<typeof useSettingsNavigationGroups>[0];
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const groups = useSettingsNavigationGroups(props.account);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {groups.map((group) => (
          <SettingsSection key={group.title} title={group.title}>
            {group.items.map(({ section, ...item }) =>
              section === "SettingsAuth" ? (
                <SettingsRow
                  key={section}
                  {...item}
                  onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
                />
              ) : (
                <SettingsRow key={section} {...item} target={section} />
              ),
            )}
          </SettingsSection>
        ))}
      </ScrollView>
    </View>
  );
}

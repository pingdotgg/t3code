import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { NativeColumnContent } from "../../native/NativeColumnContent.ios";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { V5StackHeader } from "../../native/V5StackHeader.ios";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { useSettingsScopeHeaderItem } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsEnvironmentFilterProvider } from "./settings-environment-filter";
import {
  SETTINGS_SEARCH_ITEMS,
  searchSettings,
  settingsSearchItemSection,
  type SettingsSearchItem,
} from "./settings-search";
import type { SettingsSection } from "./settings-sections";
import { useSettingsAccount, useSettingsNavigationGroups } from "./use-settings-navigation-groups";

interface SettingsSidebarProps {
  readonly selectedSection: SettingsSection | null;
  readonly onSelect: (page: SettingsSearchItem["page"]) => void;
  readonly onClose: () => void;
}

/** Settings sections in the primary column while their content fills the detail column. */
export function SettingsSidebarColumn(props: SettingsSidebarProps) {
  return (
    <SettingsEnvironmentFilterProvider>
      {hasCloudPublicConfig() ? (
        <ConfiguredSettingsSidebar {...props} />
      ) : (
        <SettingsSidebar {...props} account={null} />
      )}
    </SettingsEnvironmentFilterProvider>
  );
}

function ConfiguredSettingsSidebar(props: SettingsSidebarProps) {
  return <SettingsSidebar {...props} account={useSettingsAccount()} />;
}

function SettingsSidebar(
  props: SettingsSidebarProps & {
    readonly account: Parameters<typeof useSettingsNavigationGroups>[0];
  },
) {
  const insets = useSafeAreaInsets();
  const groups = useSettingsNavigationGroups(props.account);
  const scope = useSettingsScopeHeaderItem();
  const searchRef = useRef<SearchBarCommands>(null);
  const [query, setQuery] = useState("");
  const sections = new Map(
    groups.flatMap((group) => group.items).map((item) => [item.section, item]),
  );
  const results = searchSettings(
    query,
    SETTINGS_SEARCH_ITEMS.filter((item) => sections.has(settingsSearchItemSection(item))),
  );
  const resultDisabled = (item: SettingsSearchItem) =>
    sections.get(settingsSearchItemSection(item))?.disabled === true;
  const select = (page: SettingsSearchItem["page"]) => {
    if (query) {
      searchRef.current?.cancelSearch();
      setQuery("");
    }
    props.onSelect(page);
  };
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    return true;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);

  return (
    <>
      <V5StackHeader
        canGoBack={false}
        primary
        options={{
          headerShown: true,
          title: "Settings",
          // Same bar as Home's sidebar, so the drawer shows through behind the title and search.
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED
            ? { backgroundColor: "transparent" }
            : undefined,
          headerShadowVisible: false,
          headerTitleStyle: { fontSize: 18, fontWeight: "800" },
          unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
          unstable_headerLeftItems: () => [
            withNativeGlassHeaderItem({
              type: "button",
              label: "",
              accessibilityLabel: "Close settings",
              icon: { type: "sfSymbol", name: "chevron.backward" } as const,
              onPress: props.onClose,
            }),
          ],
          unstable_headerRightItems: () => [scope.item],
          headerSearchBarOptions: {
            ref: searchRef,
            autoCapitalize: "none",
            hideNavigationBar: false,
            hideWhenScrolling: false,
            obscureBackground: false,
            placeholder: "Search",
            placement: "stacked",
            allowToolbarIntegration: false,
            onChangeText: (event) => setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(""),
            onSearchButtonPress: () => {
              const first = results.find((item) => !resultDisabled(item));
              if (first) select(first.page);
            },
          },
        }}
      />
      <NativeColumnContent primary>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-0.5 px-3 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
          {query.trim() ? (
            results.length > 0 ? (
              results.map((item) => {
                const section = sections.get(settingsSearchItemSection(item));
                return section ? (
                  <SettingsSidebarRow
                    key={item.id}
                    icon={section.icon}
                    label={item.title}
                    subtitle={section.label}
                    selected={false}
                    disabled={section.disabled}
                    onPress={() => select(item.page)}
                  />
                ) : null;
              })
            ) : (
              <Text
                textRole="footnote"
                className="px-3 py-6 text-center text-drawer-foreground-muted"
              >
                No settings found
              </Text>
            )
          ) : (
            groups.map((group) => (
              <View key={group.title} className="gap-0.5">
                <Text
                  textRole="footnote"
                  className="px-3 pb-1 pt-4 font-t3-medium text-drawer-foreground-muted"
                >
                  {group.title}
                </Text>
                {group.items.map((item) => (
                  <SettingsSidebarRow
                    key={item.section}
                    icon={item.icon}
                    label={item.label}
                    {...(item.value === undefined
                      ? {}
                      : item.valuePosition === "trailing"
                        ? { detail: item.value }
                        : { subtitle: item.value })}
                    selected={item.section === props.selectedSection}
                    disabled={item.disabled}
                    onPress={() => select(item.section)}
                  />
                ))}
              </View>
            ))
          )}
        </ScrollView>
      </NativeColumnContent>
    </>
  );
}

function SettingsSidebarRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly subtitle?: string;
  readonly detail?: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const mutedClassName = props.selected
    ? "text-thread-selected-foreground-muted"
    : "text-drawer-foreground-muted";
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.subtitle, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{ selected: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      interactionClassName="bg-thread-hover"
      interactionOpacity={props.selected ? 0 : 1}
      className={cn(
        "min-h-11 flex-row items-center gap-3 rounded-xl px-3 py-2",
        props.selected && "bg-thread-selected",
        props.disabled && "opacity-45",
      )}
    >
      <View className="w-6 items-center">
        <SymbolView
          name={props.icon}
          size={18}
          tintColorClassName={
            props.selected ? "accent-thread-selected-foreground" : "accent-drawer-foreground-muted"
          }
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          textRole="body"
          numberOfLines={1}
          className={props.selected ? "text-thread-selected-foreground" : "text-drawer-foreground"}
        >
          {props.label}
        </Text>
        {props.subtitle ? (
          <Text textRole="footnote" numberOfLines={1} className={mutedClassName}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.detail ? (
        <Text textRole="footnote" numberOfLines={1} className={cn("tabular-nums", mutedClassName)}>
          {props.detail}
        </Text>
      ) : null}
    </RowPressable>
  );
}

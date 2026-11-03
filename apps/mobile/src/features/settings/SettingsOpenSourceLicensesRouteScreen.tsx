import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { SearchField } from "../../components/ui/SearchField";
import { Toolbar } from "../../components/ui/Toolbar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { LegendList } from "@legendapp/list/react-native";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  filterThirdPartyLicenseEntries,
  findThirdPartyLicenseEntry,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "@t3tools/shared/thirdPartyLicenses";
import { useMemo, useRef, useState } from "react";
import { Linking, Platform, Pressable, type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";

import { getMobileThirdPartyLicenses } from "./mobileThirdPartyLicenses";

function useMobileThirdPartyLicenses() {
  return useMemo(() => {
    try {
      return getMobileThirdPartyLicenses();
    } catch {
      return null;
    }
  }, []);
}

function LicenseRow(props: {
  readonly entry: ThirdPartyLicenseEntry;
  readonly onPress: () => void;
}) {
  return (
    <View className="border-b border-border">
      <ListRow
        label={props.entry.name}
        description={[props.entry.version, props.entry.license].filter(Boolean).join(" · ")}
        onPress={props.onPress}
      />
    </View>
  );
}

export function SettingsOpenSourceLicensesRouteScreen() {
  const searchRef = useRef<TextInputInstance>(null);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const manifest = useMobileThirdPartyLicenses();
  const entries = manifest?.entries ?? [];
  const filteredEntries = filterThirdPartyLicenseEntries(entries, query);
  const renderItem = ({ item }: { readonly item: ThirdPartyLicenseEntry }) => (
    <LicenseRow
      entry={item}
      onPress={() =>
        navigation.navigate("SettingsOpenSourceLicense", {
          entryKey: thirdPartyLicenseEntryKey(item),
        })
      }
    />
  );

  if (!manifest) {
    return (
      <SettingsScreen title="Open source licenses">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-foreground-muted">
            License notices are unavailable in this build.
          </Text>
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Open source licenses">
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            unstable_headerToolbarItems: usesNativeMailSearchToolbar
              ? () => [
                  createNativeMailSearchToolbarItem({
                    onSearchTextChange: setQuery,
                    placeholder: "Search packages",
                    searchTextChangeId: "open-source-licenses-search-text",
                    showsSearchDismissButton: true,
                  }),
                ]
              : undefined,
            headerSearchBarOptions: usesNativeMailSearchToolbar
              ? undefined
              : {
                  allowToolbarIntegration: true,
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => setQuery(""),
                  onChangeText: (event) => setQuery(event.nativeEvent.text),
                  placeholder: "Search packages",
                },
          }}
        />
      ) : null}
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <Toolbar placement="bottom">
          <Toolbar.SearchBarSlot />
        </Toolbar>
      ) : null}

      <LegendList
        renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: usesNativeMailSearchToolbar
            ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 18
            : Platform.OS === "ios"
              ? 18
              : Math.max(insets.bottom, 18) + 18,
        }}
        contentInsetAdjustmentBehavior="automatic"
        data={filteredEntries}
        estimatedItemSize={78}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={thirdPartyLicenseEntryKey}
        ListEmptyComponent={
          <View className="items-center px-6 py-12">
            <Text className="text-center text-base text-foreground-muted">
              No licenses match that search.
            </Text>
          </View>
        }
        ListHeaderComponent={
          Platform.OS !== "ios" ? (
            <View className="px-5 pt-4 pb-5">
              <SearchField
                inputRef={searchRef}
                autoFocus={false}
                accessibilityLabel="Search open-source licenses"
                clearAccessibilityLabel="Clear package search"
                onChangeText={setQuery}
                placeholder="Search packages"
                value={query}
              />
            </View>
          ) : null
        }
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
      />
    </SettingsScreen>
  );
}

type LicenseDetailProps = StaticScreenProps<{ readonly entryKey: string }>;

export function SettingsOpenSourceLicenseRouteScreen({ route }: LicenseDetailProps) {
  const insets = useSafeAreaInsets();
  const manifest = useMobileThirdPartyLicenses();
  const entry = manifest
    ? findThirdPartyLicenseEntry(manifest.entries, route.params.entryKey)
    : undefined;
  const sourceUrl = entry?.sourceUrl?.match(/^https?:\/\//) ? entry.sourceUrl : null;

  if (!entry) {
    return (
      <SettingsScreen title="License notice">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-foreground-muted">
            This license notice is unavailable.
          </Text>
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="License notice">
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-2 px-1">
          <Text className="text-2xl font-t3-bold text-foreground">{entry.name}</Text>
          <Text className="text-base leading-normal text-foreground-muted">
            {[entry.version, entry.license, formatLicenseBundles(entry.bundles)]
              .filter((value): value is string => Boolean(value))
              .join(" · ")}
          </Text>
          {sourceUrl ? (
            <Pressable
              accessibilityHint="Opens the project website"
              accessibilityRole="link"
              onPress={() => void Linking.openURL(sourceUrl)}
              className="min-h-12 flex-row items-center gap-2 self-start py-2 active:opacity-60"
            >
              <Text className="font-t3-medium text-primary-text">Project source</Text>
              <SymbolView
                name="arrow.up.right"
                size={16}
                tintColorClassName={"accent-primary-text"}
                type="monochrome"
                weight="semibold"
              />
            </Pressable>
          ) : null}
        </View>

        <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card p-4">
          <Text selectable className="font-mono text-base leading-normal text-foreground">
            {entry.noticeText}
          </Text>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

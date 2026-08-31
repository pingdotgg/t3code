import { LegendList } from "@legendapp/list/react-native";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  filterThirdPartyLicenseEntries,
  findThirdPartyLicenseEntry,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "@t3tools/shared/thirdPartyLicenses";
import { useCallback, useMemo, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { MOBILE_THIRD_PARTY_LICENSES } from "./mobileThirdPartyLicenses";

function LicenseRow(props: {
  readonly entry: ThirdPartyLicenseEntry;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint="Opens the complete license notice"
      accessibilityLabel={`${props.entry.name}, ${props.entry.license}`}
      accessibilityRole="button"
      onPress={props.onPress}
      className="border-b border-border bg-card px-5 py-4 active:bg-card-alt"
    >
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
            {props.entry.name}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {props.entry.version ? `${props.entry.version} · ` : ""}
            {props.entry.license}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={16}
          tintColorClassName={"accent-chevron"}
          type="monochrome"
          weight="semibold"
        />
      </View>
    </Pressable>
  );
}

export function SettingsOpenSourceLicensesRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const entries = MOBILE_THIRD_PARTY_LICENSES.entries;
  const filteredEntries = useMemo(
    () => filterThirdPartyLicenseEntries(entries, query),
    [entries, query],
  );
  const renderItem = useCallback(
    ({ item }: { readonly item: ThirdPartyLicenseEntry }) => (
      <LicenseRow
        entry={item}
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: {
              screen: "SettingsOpenSourceLicense",
              params: { entryKey: thirdPartyLicenseEntryKey(item) },
            },
          })
        }
      />
    ),
    [navigation],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Open source licenses" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <LegendList
        className="flex-1"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
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
          <View className="gap-4 px-5 pt-4 pb-5">
            <Text className="text-base leading-normal text-foreground-muted">
              Third-party notices for dependencies and assets included in T3 Code Mobile.
            </Text>
            <TextInput
              accessibilityLabel="Search open-source licenses"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={setQuery}
              placeholder="Search packages"
              returnKeyType="search"
              value={query}
            />
            <Text className="tabular-nums text-sm text-foreground-muted">
              {filteredEntries.length === entries.length
                ? `${String(entries.length)} notices`
                : `${String(filteredEntries.length)} of ${String(entries.length)} notices`}
            </Text>
          </View>
        }
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

type LicenseDetailProps = StaticScreenProps<{ readonly entryKey: string }>;

export function SettingsOpenSourceLicenseRouteScreen({ route }: LicenseDetailProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const entry = findThirdPartyLicenseEntry(
    MOBILE_THIRD_PARTY_LICENSES.entries,
    route.params.entryKey,
  );
  const sourceUrl = entry?.sourceUrl?.match(/^https?:\/\//) ? entry.sourceUrl : null;

  if (!entry) {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        {Platform.OS === "android" ? (
          <>
            <NativeStackScreenOptions options={{ headerShown: false }} />
            <AndroidScreenHeader title="License notice" onBack={() => navigation.goBack()} />
          </>
        ) : null}
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-foreground-muted">
            This license notice is unavailable.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="License notice" onBack={() => navigation.goBack()} />
        </>
      ) : null}
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
              <Text className="font-t3-medium text-primary">Project source</Text>
              <SymbolView
                name="arrow.up.right"
                size={16}
                tintColorClassName={"accent-primary"}
                type="monochrome"
                weight="semibold"
              />
            </Pressable>
          ) : null}
        </View>

        <View className="overflow-hidden rounded-[24px] border-continuous bg-card p-4">
          <Text selectable className="font-mono text-base leading-normal text-foreground">
            {entry.noticeText}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

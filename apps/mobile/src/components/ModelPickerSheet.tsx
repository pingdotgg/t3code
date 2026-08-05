import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Keyboard, Modal, Platform, Pressable, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import {
  buildModelPickerProviderGroups,
  type ModelOption,
  type ProviderGroup,
} from "../lib/modelOptions";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { ProviderIcon } from "./ProviderIcon";

type ModelPickerListItem =
  | {
      readonly key: string;
      readonly type: "provider";
      readonly providerLabel: string;
    }
  | {
      readonly key: string;
      readonly type: "legacy";
      readonly providerKey: ProviderInstanceId;
      readonly count: number;
      readonly expanded: boolean;
      readonly searching: boolean;
    }
  | {
      readonly key: string;
      readonly type: "model";
      readonly option: ModelOption;
    };

function selectedModelKey(selection: ModelSelection | null): string | null {
  return selection ? `${selection.instanceId}:${selection.model}` : null;
}

function favoriteModelsFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteModelKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const favoriteDelta =
        Number(favoriteModelKeys.has(b.model.key)) - Number(favoriteModelKeys.has(a.model.key));
      return favoriteDelta === 0 ? a.index - b.index : favoriteDelta;
    })
    .map(({ model }) => model);
}

export function ModelPickerSheet(props: {
  readonly visible: boolean;
  readonly groups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly favoriteModelKeys: ReadonlySet<string>;
  readonly favoritesEnabled: boolean;
  readonly onClose: () => void;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly onToggleFavorite: (option: ModelOption) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [expandedLegacyProviders, setExpandedLegacyProviders] = useState(
    () => new Set<ProviderInstanceId>(),
  );
  const selectedKey = selectedModelKey(props.selectedModel);

  useEffect(() => {
    if (!props.visible) return;
    setQuery("");
    const selectedLegacy = props.groups
      .flatMap((group) => group.models)
      .find((model) => model.key === selectedKey && model.isLegacy);
    setExpandedLegacyProviders(selectedLegacy ? new Set([selectedLegacy.providerKey]) : new Set());
  }, [props.groups, props.visible, selectedKey]);

  const filteredGroups = useMemo(
    () => buildModelPickerProviderGroups(props.groups, query),
    [props.groups, query],
  );
  const searching = query.trim().length > 0;
  const listItems = useMemo(() => {
    const items: ModelPickerListItem[] = [];
    for (const group of filteredGroups) {
      items.push({
        key: `provider:${group.providerKey}`,
        type: "provider",
        providerLabel: group.providerLabel,
      });
      for (const option of favoriteModelsFirst(group.currentModels, props.favoriteModelKeys)) {
        items.push({ key: `model:${option.key}`, type: "model", option });
      }
      if (group.legacyModels.length > 0) {
        const expanded = searching || expandedLegacyProviders.has(group.providerKey);
        items.push({
          key: `legacy:${group.providerKey}`,
          type: "legacy",
          providerKey: group.providerKey,
          count: group.legacyModels.length,
          expanded,
          searching,
        });
        if (expanded) {
          for (const option of favoriteModelsFirst(group.legacyModels, props.favoriteModelKeys)) {
            items.push({ key: `model:${option.key}`, type: "model", option });
          }
        }
      }
    }
    return items;
  }, [expandedLegacyProviders, filteredGroups, props.favoriteModelKeys, searching]);

  const toggleLegacyProvider = (providerKey: ProviderInstanceId) => {
    setExpandedLegacyProviders((current) => {
      const next = new Set(current);
      if (next.has(providerKey)) next.delete(providerKey);
      else next.add(providerKey);
      return next;
    });
  };

  return (
    <Modal
      allowSwipeDismissal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      statusBarTranslucent={Platform.OS === "android"}
      visible={props.visible}
    >
      <SafeAreaView
        className="flex-1 bg-black"
        edges={["bottom"]}
        style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
      >
        <View className="items-center pb-1 pt-2">
          <View className="h-1.5 w-16 rounded-full bg-[#515157]" />
        </View>

        <View className="h-[68px] flex-row items-center px-5">
          <Pressable
            accessibilityLabel="Close model picker"
            accessibilityRole="button"
            className="h-12 w-[92px] items-center justify-center rounded-full border border-white/10 bg-[#242426] active:opacity-70"
            onPress={props.onClose}
          >
            <Text className="text-lg font-t3-medium text-[#f4f4f5]">Cancel</Text>
          </Pressable>
          <Text className="flex-1 text-center text-xl font-t3-bold text-white">Choose model</Text>
          <View className="w-[92px]" />
        </View>

        <View className="px-5 pb-3">
          <View className="h-[52px] flex-row items-center gap-3 rounded-full border border-white/10 bg-[#202022] px-4">
            <SymbolView name="magnifyingglass" size={22} tintColor="#f4f4f5" type="monochrome" />
            <TextInput
              accessibilityLabel="Search models"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-w-0 flex-1 text-lg text-white"
              clearButtonMode="while-editing"
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor="#85858b"
              selectionColor="#60a5fa"
              value={query}
            />
          </View>
        </View>

        <FlatList
          data={listItems}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) }}
          ListEmptyComponent={
            <View className="items-center px-8 py-16">
              <Text className="text-center text-base text-[#85858b]">
                {query.trim().length > 0
                  ? `No models match “${query.trim()}”.`
                  : "No models found."}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            if (item.type === "provider") {
              return (
                <Text className="px-5 pb-3 pt-8 text-lg font-t3-bold text-[#85858b]">
                  {item.providerLabel}
                </Text>
              );
            }

            if (item.type === "legacy") {
              return (
                <Pressable
                  accessibilityLabel={`${item.expanded ? "Hide" : "Show"} ${item.count} legacy models`}
                  accessibilityRole="button"
                  className="mx-5 min-h-[58px] flex-row items-center border-b border-white/10 active:opacity-70"
                  disabled={item.searching}
                  onPress={() => toggleLegacyProvider(item.providerKey)}
                >
                  <SymbolView name="archivebox" size={20} tintColor="#77777d" type="monochrome" />
                  <Text className="ml-3 flex-1 text-base font-t3-medium text-[#a2a2a8]">
                    Legacy models
                  </Text>
                  <Text className="mr-2 text-sm text-[#6f6f75]">{item.count}</Text>
                  {!item.searching ? (
                    <SymbolView
                      name={item.expanded ? "chevron.up" : "chevron.down"}
                      size={14}
                      tintColor="#77777d"
                      type="monochrome"
                    />
                  ) : null}
                </Pressable>
              );
            }

            const selected = item.option.key === selectedKey;
            const favorite = props.favoriteModelKeys.has(item.option.key);
            return (
              <View className="mx-5 min-h-[82px] flex-row items-center border-b border-white/10">
                <Pressable
                  accessibilityLabel={`${item.option.label}, ${item.option.selection.model}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  className="min-w-0 flex-1 flex-row items-center self-stretch active:opacity-70"
                  onPress={() => {
                    Keyboard.dismiss();
                    props.onSelectModel(item.option);
                    props.onClose();
                  }}
                >
                  <View className="w-12 items-start">
                    <ProviderIcon provider={item.option.providerDriver} size={28} />
                  </View>
                  <View className="min-w-0 flex-1 py-3">
                    <Text className="text-lg font-t3-bold text-[#f5f5f6]" numberOfLines={1}>
                      {item.option.label}
                    </Text>
                    <Text className="mt-0.5 text-sm text-[#909096]" numberOfLines={1}>
                      {item.option.selection.model}
                    </Text>
                  </View>
                  {selected ? (
                    <SymbolView name="checkmark" size={22} tintColor="#f5f5f6" type="monochrome" />
                  ) : null}
                </Pressable>
                <Pressable
                  accessibilityLabel={favorite ? "Remove from favorites" : "Add to favorites"}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !props.favoritesEnabled }}
                  className="ml-3 h-11 w-11 items-center justify-center active:opacity-60"
                  disabled={!props.favoritesEnabled}
                  hitSlop={4}
                  onPress={() => props.onToggleFavorite(item.option)}
                  style={{ opacity: props.favoritesEnabled ? 1 : 0.45 }}
                >
                  <SymbolView
                    name={favorite ? "star.fill" : "star"}
                    size={23}
                    tintColor={favorite ? "#facc15" : "#77777d"}
                    type="monochrome"
                  />
                </Pressable>
              </View>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

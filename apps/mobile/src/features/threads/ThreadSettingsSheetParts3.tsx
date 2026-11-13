import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import * as Dialog from "../../components/ui/Dialog";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
} from "@t3tools/shared/serverSettings";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  useNavigation,
  useRoute,
  type RouteProp,
  type StaticScreenProps,
} from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { IconButton } from "../../components/ui/IconButton";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useReduceMotionEnabled } from "../../lib/appState";
import {
  buildModelOptions,
  groupByProvider,
  type ModelOption,
  type ProviderGroup,
} from "../../lib/modelOptions";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { ChatGptSharingStatus } from "./ChatGptSharingStatus";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentQuery } from "../../state/query";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadReportedModelSelection } from "../../state/entities";
import {
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
  useComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { activeComposerDraftKey, useQueuedRunEdit } from "../../state/queued-run-edit";
import { updateThreadDraftModelSelection } from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { threadAllowsProviderSwitch } from "../../state/thread-provider-switching";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { ScreenContent } from "../../components/ui/ScreenContent";
import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { ModelRow, ChoiceRow } from "./ThreadSettingsRows";
import {
  compatibleRuntimeModeForChoices,
  runtimeModeChoicesForSupportedModes,
  withManagedRuntimeModeLimits,
  type RuntimeModeChoice,
  selectableChoices,
} from "./thread-settings-options";
import {
  canCommitPendingModel,
  favoritesFirst,
  modelFavoriteKey,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  providerSectionIsCollapsed,
} from "./thread-settings-sheet-state";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { ThreadSettingsSessionProvider } from "./ThreadSettingsSheetParts";
import { ThreadSettingsModelsScreen } from "./ThreadSettingsSheetParts2";
import type { ThreadSettingsCatalogItem, ThreadSettingsSubmenuPage } from "./ThreadSettingsSheet";
import { FAVORITES_PROVIDER_FILTER, THREAD_SETTINGS_CATALOG_ENTER_TRANSITION, THREAD_SETTINGS_CATALOG_EXIT_TRANSITION, THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION, THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION, ThreadSettingsModelListRow, ThreadSettingsOptionsItem, ThreadSettingsProviderListHeader, buildThreadSettingsCatalogItems, useThreadSettingsSession } from "./ThreadSettingsSheet";

export function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const session = useThreadSettingsSession();
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshProviderCatalog = createProviderCatalogRefreshRunner(refreshProvidersCommand);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshProviders = () => {
    if (!session.environmentId || isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    void refreshProviderCatalog(session.environmentId).then((result) => {
      setIsRefreshingProviders(false);
      const error = providerCatalogRefreshError(result);
      if (error) Dialog.alert("Could not refresh models", error);
    });
  };
  const [listLoaded, setListLoaded] = useState(false);
  // Android can drop the first frame of a reduced-motion fade, leaving rows invisible.
  const reducedMotion = useReducedMotion();
  const reduceMotionEnabled = useReduceMotionEnabled();
  const animationsReady = listLoaded && !reducedMotion && !reduceMotionEnabled;
  const catalogItems = buildThreadSettingsCatalogItems(session);
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const listItems = [
    ...(catalogItems.length === 0 ? ([{ kind: "empty", key: "empty" }] as const) : catalogItems),
    { kind: "options", key: "options" },
  ] satisfies ReadonlyArray<ThreadSettingsCatalogItem>;
  const renderCatalogItem = (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
    const item = itemProps.item;
    let content: ReactNode;

    if (item.kind === "provider") {
      content = <ThreadSettingsProviderListHeader provider={item.provider} />;
    } else if (item.kind === "model") {
      content = (
        <ThreadSettingsModelListRow
          isFirst={item.isFirst}
          isLast={item.isLast}
          option={item.option}
        />
      );
    } else if (item.kind === "notice") {
      content = <Text className="mx-8 mt-2 text-xs text-foreground-muted">{item.text}</Text>;
    } else if (item.kind === "empty") {
      content = (
        <View className="items-center px-8 py-14">
          <Text className="text-center text-sm text-foreground-muted">
            {session.providerFilter === FAVORITES_PROVIDER_FILTER &&
            session.searchQuery.trim().length === 0
              ? "No favorite models"
              : hasActiveCatalogFilter
                ? "No matching models"
                : "No available models"}
          </Text>
        </View>
      );
    } else {
      content = (
        <ThreadSettingsOptionsItem
          animationsReady={animationsReady}
          onOpenSubmenu={props.onOpenSubmenu}
        />
      );
    }

    return (
      <Animated.View
        key={item.key}
        entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
        exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
      >
        {content}
      </Animated.View>
    );
  };

  return (
    // oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling.
    <AnimatedLegendList
      alwaysBounceVertical
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{ paddingTop: 4 }}
      contentInsetAdjustmentBehavior="automatic"
      data={listItems}
      estimatedItemSize={Platform.OS === "android" ? 56 : 48}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListHeaderComponent={
        <>
          {Platform.OS === "android" ? (
            <View className="px-4 pb-2 pt-3">
              <View
                className="flex-row items-center rounded-full bg-input px-2"
                style={{ minHeight: 56 }}
              >
                <View pointerEvents="none" className="px-2">
                  <SymbolView
                    name="magnifyingglass"
                    size={24}
                    tintColorClassName="accent-icon-subtle"
                  />
                </View>
                <TextInput
                  accessibilityLabel="Find a model"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-w-0 flex-1 px-2 py-0 text-base text-foreground"
                  style={{ minHeight: 56, includeFontPadding: false, textAlignVertical: "center" }}
                  onChangeText={session.setSearchQuery}
                  placeholder="Find a model"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  cursorColorClassName="accent-focus"
                  selectionHandleColorClassName="accent-focus"
                  value={session.searchQuery}
                />
                {session.searchQuery.length > 0 ? (
                  <IconButton
                    accessibilityLabel="Clear model search"
                    icon="xmark"
                    onPress={() => session.setSearchQuery("")}
                  />
                ) : null}
              </View>
            </View>
          ) : null}
        </>
      }
      recycleItems
      refreshControl={
        session.environmentId ? (
          <RefreshControl refreshing={isRefreshingProviders} onRefresh={refreshProviders} />
        ) : undefined
      }
      onLoad={() => setListLoaded(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}


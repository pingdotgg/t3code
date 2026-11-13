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
import type { ThreadSettingsPickerStackParams } from "./ThreadSettingsSheet";
import { FAVORITES_PROVIDER_FILTER, ThreadSettingsMainContent, useThreadSettingsMailSearchToolbar, useThreadSettingsPickerPresentation, useThreadSettingsSession } from "./ThreadSettingsSheet";

export function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const usesNativeMailSearchToolbar = useThreadSettingsMailSearchToolbar();
  const hasCustomCatalogFilter = session.providerFilter !== null || session.showLegacy;
  const commitAndClose = useEffectEvent(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  });
  const providerFilters = [
    { id: "all-providers", title: "All providers", value: null },
    { id: "favorites", title: "Favorites", value: FAVORITES_PROVIDER_FILTER },
    ...session.providerGroups.map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      value: group.providerKey,
    })),
  ];
  const filterMenu = {
    title: "Model filters",
    items: [
      {
        type: "submenu" as const,
        title: "Provider",
        items: providerFilters.map((filter) => ({
          type: "action" as const,
          title: filter.title,
          state: session.providerFilter === filter.value ? ("on" as const) : ("off" as const),
          onPress: () => session.setProviderFilter(filter.value),
        })),
      },
      ...(session.hasLegacyModels
        ? [
            {
              type: "action" as const,
              title: "Show legacy models",
              state: session.showLegacy ? ("on" as const) : ("off" as const),
              onPress: () => session.setShowLegacy(!session.showLegacy),
            },
          ]
        : []),
    ],
  };

  return (
    <>
      {Platform.OS === "android" ? (
        <SheetHeader
          trailing={
            <View className="flex-row items-center">
              <AndroidAnchoredMenu
                title="Model filters"
                actions={[
                  {
                    title: "Provider",
                    subactions: providerFilters.map((filter) => ({
                      id: filter.id,
                      title: filter.title,
                      state: session.providerFilter === filter.value ? "on" : "off",
                    })),
                  },
                  ...(session.hasLegacyModels
                    ? [
                        {
                          id: "show-legacy",
                          title: "Show legacy models",
                          state: session.showLegacy ? ("on" as const) : ("off" as const),
                        },
                      ]
                    : []),
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "show-legacy") {
                    session.setShowLegacy(!session.showLegacy);
                  } else {
                    const filter = providerFilters.find((item) => item.id === nativeEvent.event);
                    if (filter) session.setProviderFilter(filter.value);
                  }
                }}
              >
                {(open) => (
                  <IconButton
                    accessibilityLabel="Filter models"
                    icon="line.3.horizontal.decrease"
                    selected={hasCustomCatalogFilter}
                    variant={hasCustomCatalogFilter ? "tonal" : "standard"}
                    onPress={open}
                  />
                )}
              </AndroidAnchoredMenu>
            </View>
          }
          onCancel={presentation.onClose}
          title="Thread settings"
          confirm={session.pendingModel ? { label: "Save", onPress: commitAndClose } : undefined}
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[
          session.providerFilter,
          session.providerGroups.map((group) => group.providerKey),
          session.showLegacy,
        ]}
        options={{
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  filterButtonId: "thread-settings-model-filter",
                  filterMenu,
                  filterSystemImageName: hasCustomCatalogFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onSearchTextChange: session.setSearchQuery,
                  placeholder: "Find a model",
                  searchTextChangeId: "thread-settings-model-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios" && !usesNativeMailSearchToolbar
              ? {
                  allowToolbarIntegration: true,
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <ScreenContent>
        <ThreadSettingsMainContent
          onOpenSubmenu={(submenu) => {
            const title =
              submenu.kind === "runtime"
                ? "Runtime"
                : (session.displayedDescriptors.find(
                    (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
                  )?.label ?? "Option");
            navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
          }}
        />
      </ScreenContent>
      {Platform.OS === "ios" ? (
        <SheetHeader
          title="Thread settings"
          onCancel={presentation.onClose}
          accessibilityLabel="Cancel thread settings"
          confirm={{
            label: session.pendingModel ? "Save thread settings" : "Done",
            onPress: commitAndClose,
          }}
        />
      ) : null}
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <Toolbar placement="bottom">
          <Toolbar.Menu
            accessibilityLabel="Filter models"
            icon={
              hasCustomCatalogFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Model filters"
          >
            <Toolbar.Menu title="Provider">
              <Toolbar.Label>Provider</Toolbar.Label>
              <Toolbar.MenuAction
                isOn={session.providerFilter === null}
                onPress={() => session.setProviderFilter(null)}
              >
                All providers
              </Toolbar.MenuAction>
              <Toolbar.MenuAction
                isOn={session.providerFilter === FAVORITES_PROVIDER_FILTER}
                onPress={() => session.setProviderFilter(FAVORITES_PROVIDER_FILTER)}
              >
                Favorites
              </Toolbar.MenuAction>
              {session.providerGroups.map((group) => (
                <Toolbar.MenuAction
                  key={group.providerKey}
                  isOn={session.providerFilter === group.providerKey}
                  onPress={() => session.setProviderFilter(group.providerKey)}
                >
                  {group.providerLabel}
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>
            {session.hasLegacyModels ? (
              <Toolbar.MenuAction
                isOn={session.showLegacy}
                onPress={() => session.setShowLegacy(!session.showLegacy)}
              >
                Show legacy models
              </Toolbar.MenuAction>
            ) : null}
          </Toolbar.Menu>
          <Toolbar.SearchBarSlot />
        </Toolbar>
      ) : null}
    </>
  );
}


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
import { ThreadSettingsChoiceContent } from "./ThreadSettingsSheetParts4";
import type { ThreadSettingsSubmenuPage } from "./ThreadSettingsSheet";
import { DisclosureRow, SwitchRow, THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION, THREAD_SETTINGS_OPTION_ENTER_TRANSITION, THREAD_SETTINGS_OPTION_EXIT_TRANSITION, useThreadSettingsSession } from "./ThreadSettingsSheet";

export function ThreadSettingsOptionsItem(props: {
  readonly animationsReady: boolean;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId) ?? null)
    : null;
  // Both iOS search layouts float a bottom toolbar over the list's last rows.
  const bottomToolbarInset = Platform.OS === "ios" ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET : 0;

  return (
    <View style={{ paddingBottom: insets.bottom + bottomToolbarInset + 12 }}>
      <ChatGptSharingStatus provider={selectedProvider} />
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">Options</Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-grouped-card"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        {session.displayedDescriptors.map((descriptor) => {
          if (descriptor.type === "select") {
            return (
              <Animated.View
                key={descriptor.id}
                entering={
                  props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined
                }
                exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
                layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
              >
                <DisclosureRow
                  label={descriptor.label}
                  value={
                    session.promptTraits.ultrathinkPromptControlled &&
                    descriptor.id === session.promptTraits.primarySelectDescriptor?.id
                      ? "Ultrathink"
                      : getProviderOptionCurrentLabel(
                          descriptor,
                          session.displayedModelSelection,
                          session.reportedModelSelection,
                        )
                  }
                  onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
                />
              </Animated.View>
            );
          }
          return (
            <Animated.View
              key={descriptor.id}
              entering={props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined}
              exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
              layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
            >
              <SwitchRow
                label={descriptor.label}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </Animated.View>
          );
        })}
        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
          <DisclosureRow
            isLast
            label="Runtime"
            value={
              session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)
                ?.label
            }
            onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
          />
        </Animated.View>
      </Animated.View>

      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">Catalog</Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        <SwitchRow
          label="Manage hidden models"
          value={session.manageHidden}
          onValueChange={session.setManageHidden}
          isLast={Platform.OS === "ios" || !session.hasLegacyModels}
        />
        {Platform.OS !== "ios" && session.hasLegacyModels ? (
          <SwitchRow
            isLast
            label="Legacy models"
            onValueChange={session.setShowLegacy}
            value={session.showLegacy}
          />
        ) : null}
      </View>
    </View>
  );
}


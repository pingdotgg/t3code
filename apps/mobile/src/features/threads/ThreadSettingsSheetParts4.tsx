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
import type { ThreadSettingsSubmenuPage } from "./ThreadSettingsSheet";
import { useThreadSettingsSession } from "./ThreadSettingsSheet";

export function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          rows: session.runtimeModeChoices.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.disabledReason ?? choice.description,
            disabled: choice.disabledReason !== undefined,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            rows: selectableChoices(activeDescriptor).map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              disabled: false,
              selected:
                choice.id ===
                (session.promptTraits.ultrathinkPromptControlled &&
                activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                  ? "ultrathink"
                  : getProviderOptionCurrentValue(
                      activeDescriptor,
                      session.displayedModelSelection,
                      session.reportedModelSelection,
                    )),
              onPress: () => {
                void Haptics.selectionAsync();
                if (
                  session.promptTraits.ultrathinkInBodyText &&
                  activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                ) {
                  Dialog.alert(
                    "Reasoning controlled by prompt",
                    'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                  );
                  return;
                }
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            selected={row.selected}
            disabled={row.disabled}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}


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
import type { ThreadSettingsSessionProps, ThreadSettingsSessionValue } from "./ThreadSettingsSheet";
import { EMPTY_MODEL_FAVORITES, ThreadSettingsSessionContext, attemptedMigrationGenerations } from "./ThreadSettingsSheet";

export function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const registry = use(RegistryContext);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = props.environmentId ? configs.get(props.environmentId) : undefined;
  const settings = config?.settings;
  const connection = useEnvironmentQuery(
    props.environmentId ? environmentCatalog.stateAtom(props.environmentId) : null,
  ).data;
  const connectionGeneration = connection?.phase === "connected" ? connection.generation : null;
  const [manageHidden, setManageHidden] = useState(false);
  const pendingHidden = useRef(new Set<string>());
  const pendingFavorites = useRef(
    new Map<string, { favorite: boolean; settings: ServerSettings; pending: boolean }>(),
  );
  const [pendingHiddenKeys, setPendingHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const providerGroups =
    manageHidden && config
      ? groupByProvider(
          buildModelOptions(
            config,
            props.selectedModel,
            props.lockedProviderInstanceId,
            props.projectId,
            true,
          ),
        )
      : props.providerGroups;
  const legacyFavorites = AsyncResult.isSuccess(preferences)
    ? (preferences.value.modelFavorites ?? EMPTY_MODEL_FAVORITES)
    : EMPTY_MODEL_FAVORITES;
  const favoritesLoaded =
    settings !== undefined && (settings.favorites !== null || AsyncResult.isSuccess(preferences));
  const modelFavorites = resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, {
    favorites: legacyFavorites,
  }).favorites;
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, "model favorites update");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the one-time legacy model favorites migration to server settings once per connection
  useEffect(() => {
    if (
      !props.environmentId ||
      !settings ||
      !AsyncResult.isSuccess(preferences) ||
      connectionGeneration === null ||
      attemptedMigrationGenerations.get(props.environmentId) === connectionGeneration
    )
      return;
    const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
    if (!patch) return;
    attemptedMigrationGenerations.set(props.environmentId, connectionGeneration);
    void saveSettings({ environmentId: props.environmentId, input: { patch } });
  }, [
    connectionGeneration,
    legacyFavorites,
    preferences,
    props.environmentId,
    saveSettings,
    settings,
  ]);
  const favoriteKeys = new Set(
    modelFavorites.map((favorite) => modelFavoriteKey(favorite.provider, favorite.model)),
  );
  const toggleFavorite = async (option: ModelOption) => {
    const environmentId = props.environmentId;
    if (!favoritesLoaded || !environmentId) return;
    const currentSettings = registry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    if (!currentSettings) return;
    const favorites = resolveModelPreferences(currentSettings, {
      favorites: legacyFavorites,
    }).favorites;
    const key = JSON.stringify([
      environmentId,
      option.selection.instanceId,
      option.selection.model,
    ]);
    const previous = pendingFavorites.current.get(key);
    const previousFavorite =
      previous && (previous.pending || previous.settings.favorites === currentSettings.favorites)
        ? previous.favorite
        : favorites.some(
            (favorite) =>
              favorite.provider === option.selection.instanceId &&
              favorite.model === option.selection.model,
          );
    const pending = { favorite: !previousFavorite, settings: currentSettings, pending: true };
    pendingFavorites.current.set(key, pending);
    void Haptics.selectionAsync();
    const result = await saveSettings({
      environmentId: environmentId,
      input: {
        patch: {
          setModelFavorites: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              favorite: pending.favorite,
            },
          ],
          ...(currentSettings.favorites === null ? { migrateModelPreferences: { favorites } } : {}),
        },
      },
    });
    if (
      AsyncResult.isSuccess(result) &&
      registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
        currentSettings.favorites
    ) {
      pending.pending = false;
    }
    if (pending.pending && pendingFavorites.current.get(key) === pending) {
      if (
        previous &&
        !previous.pending &&
        registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
          previous.settings.favorites
      ) {
        pendingFavorites.current.set(key, previous);
      } else {
        pendingFavorites.current.delete(key);
      }
    }
  };
  const toggleHidden = (option: ModelOption) => {
    if (
      !settings ||
      !props.environmentId ||
      !option.canHide ||
      pendingHidden.current.has(option.key)
    )
      return;
    pendingHidden.current.add(option.key);
    setPendingHiddenKeys(new Set(pendingHidden.current));
    void Haptics.selectionAsync();
    void saveSettings({
      environmentId: props.environmentId,
      input: {
        patch: {
          setModelsHidden: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              hidden: !option.isHidden,
            },
          ],
        },
      },
    }).then(() => {
      pendingHidden.current.delete(option.key);
      setPendingHiddenKeys(new Set(pendingHidden.current));
    });
  };
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const displayedPrompt = pendingModel ? (pendingPrompt ?? props.prompt) : props.prompt;

  const isApplied = (option: ModelOption) =>
    option.selection.instanceId === props.selectedModel?.instanceId &&
    option.selection.model === props.selectedModel.model;
  const isDisplayed = (option: ModelOption) =>
    pendingModel ? option.key === pendingModel.key : isApplied(option);

  const displayedDescriptors = pendingModel
    ? pendingModel.capabilities
      ? getProviderOptionDescriptors({
          caps: pendingModel.capabilities,
          selections: pendingModel.selection.options,
        })
      : []
    : props.optionDescriptors;
  const promptTraits = getPromptControlledTraits(displayedDescriptors, displayedPrompt);
  const displayedModel =
    pendingModel ??
    props.providerGroups.flatMap((group) => group.models).find((option) => isApplied(option)) ??
    null;
  const runtimeModeChoices = withManagedRuntimeModeLimits(
    runtimeModeChoicesForSupportedModes(displayedModel?.supportedRuntimeModes),
    [config?.managedPolicy],
  );
  const compatibleRuntimeMode = compatibleRuntimeModeForChoices(
    props.runtimeMode,
    runtimeModeChoices,
  );

  const hasLegacyModels = props.providerGroups.some((group) =>
    group.models.some((model) => model.isLegacy),
  );
  const commitPendingModel = () => {
    if (pendingModel) {
      if (!canCommitPendingModel(pendingModel, props.providerGroups)) {
        Dialog.alert(
          "Model unavailable",
          "Set up this provider on web or desktop, or select another model.",
        );
        return false;
      }
      void Haptics.selectionAsync();
      props.onSelectModel(pendingModel);
      if (pendingPrompt !== null && pendingPrompt !== props.prompt) {
        props.onPromptChange(pendingPrompt);
      }
    }
    return true;
  };

  const applyOptionChange = (id: string, value: string | boolean) => {
    const descriptor = displayedDescriptors.find((entry) => entry.id === id);
    const change =
      descriptor?.type === "select" && typeof value === "string"
        ? getTraitSelectChange(
            { ...promptTraits, descriptors: displayedDescriptors },
            descriptor,
            displayedPrompt,
            value,
          )
        : null;
    if (descriptor?.type === "select") {
      if (!change) return;
      if (change.prompt !== displayedPrompt) {
        if (pendingModel) {
          setPendingPrompt(change.prompt);
        } else {
          props.onPromptChange(change.prompt);
        }
      }
    }
    const next = change
      ? (change.modelOptions ?? [])
      : applyProviderOptionSelection(displayedDescriptors, { id, value });
    if (!next) {
      return;
    }
    if (pendingModel) {
      rememberModelOptions(pendingModel.selection.instanceId, pendingModel.selection.model, next);
      setPendingModel({
        ...pendingModel,
        selection: { ...pendingModel.selection, options: next },
      });
    } else {
      props.onUpdateOptionSelections(next);
    }
  };

  const toggleProvider = (providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  };

  const pressModel = (option: ModelOption) => {
    void Haptics.selectionAsync();
    if (isApplied(option) || option.key !== pendingModel?.key) {
      setPendingPrompt(null);
    }
    setPendingModel((current) =>
      pendingModelAfterPress({
        current,
        pressed: option,
        pressedIsApplied: isApplied(option),
        restoreSelection: props.restoreSelection,
      }),
    );
  };

  const value = {
    environmentId: props.environmentId,
    providerInstanceId: props.providerInstanceId,
    providerGroups,
    manageHidden,
    setManageHidden,
    toggleHidden,
    pendingHiddenKeys,
    runtimeMode: compatibleRuntimeMode,
    runtimeModeChoices,
    onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    displayedDescriptors,
    promptTraits,
    displayedModelSelection: pendingModel?.selection ?? props.selectedModel,
    reportedModelSelection: pendingModel ? null : (props.reportedModelSelection ?? null),
    favoriteKeys,
    favoritesLoaded,
    providerExpansionOverrides,
    hasLegacyModels,
    pendingModel,
    providerFilter,
    searchQuery,
    showLegacy: showLegacyToggle,
    applyOptionChange,
    commitPendingModel,
    isApplied,
    isDisplayed,
    pressModel,
    setProviderFilter,
    setSearchQuery,
    setShowLegacy: setShowLegacyToggle,
    toggleProvider,
    toggleFavorite,
  } satisfies ThreadSettingsSessionValue;

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}


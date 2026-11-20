import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import { useGT, useLocale, useMessages } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { useSheetStackOptions } from "../layout/nested-stacks";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import {
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
} from "@t3tools/shared/serverSettings";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
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
import { Modal, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { READABLE_WIDTH_STYLE, ROW_MIN_HEIGHT } from "../../components/ui/listMetrics";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useBarOverlap } from "../../components/ui/useBarInset";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from "react-native-reanimated";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { AppBar } from "../../components/ui/AppBar";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useReduceMotionEnabled } from "../../lib/appState";
import {
  buildModelOptions,
  groupByProvider,
  serverConfigForCwd,
  type ModelOption,
  type ProviderGroup,
  withStoredThreadModelOptions,
} from "../../lib/modelOptions";
import { groupModelsBySubProvider } from "@t3tools/client-runtime/providerSubProviders";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
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
import { selectThreadModel } from "../../state/thread-model-selection";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { providerWorkspaceSnapshotRefresh } from "../../state/provider-workspace-snapshot-refresh";
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
  filterPendingOptionSelections,
  mergePendingOptionSelections,
  modelFavoriteKey,
  modelMatchesCatalogQuery,
  overlayPendingOptionDescriptors,
  partitionThreadSettingsDescriptors,
  pendingModelAfterPress,
  providerSectionIsCollapsed,
  resolveDefaultProviderFilter,
  resolveEffectiveProviderFilter,
  resolvePendingPrompt,
  resolvePendingRuntimeMode,
  selectedProviderRuntimeModes,
  type PendingPromptEdit,
} from "./thread-settings-sheet-state";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import type { MessageResolver } from "../../i18n/messages";

const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "antigravity",
]);
/** Keep measured size changes stable; let catalog mutations return underflowing filtered lists to the top. */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];
const FAVORITES_PROVIDER_FILTER = "@favorites";
const PERMISSION_SYMBOLS = {
  "approval-required": "lock",
  "auto-accept-edits": "pencil",
  auto: "checkmark.circle",
  "full-access": "lock.open",
} as const satisfies Record<RuntimeMode, AppSymbolName>;
// Servers that predate `migrateModelPreferences` drop it and keep reporting null favorites.
const attemptedMigrationGenerations = new Map<EnvironmentId, number>();
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  /** A backend inside a provider's section, such as one of fx's: no icon. */
  readonly nested?: boolean;
  /** Why the section has no usable models, such as a signed-out backend. */
  readonly detail?: string | undefined;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const content = (
    <>
      {props.nested ? null : (
        <ProviderIcon iconUrl={props.iconUrl} provider={props.driver} size={15} />
      )}
      {props.detail ? (
        <View className="min-w-0 flex-1 py-1">
          <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
          <Text className="text-xs text-foreground-muted">{props.detail}</Text>
        </View>
      ) : (
        <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      )}
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={gt(
          "{provider}, {count, plural, one {{count} model} other {{count} models}}",
          {
            provider: props.label,
            count: props.modelCount,
          },
        )}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60"
        style={{ minHeight: ROW_MIN_HEIGHT.control }}
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View
      accessibilityRole="header"
      className={cn("mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1", props.nested && "mt-1")}
    >
      {content}
    </View>
  );
}

function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      style={{ minHeight: ROW_MIN_HEIGHT.item }}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between bg-grouped-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" };

type ThreadSettingsSessionProps = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly promptDraftKey?: string;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
};

/** The composer draft the sheet edits: the thread's own, or a queued message being edited. */
export type ExistingThreadSettingsRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftKey: string;
};

type ThreadSettingsSessionValue = {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesLoaded: boolean;
  readonly toggleFavorite: (option: ModelOption) => void;
  readonly toggleHidden: (option: ModelOption) => void;
  readonly pendingHiddenKeys: ReadonlySet<string>;
  readonly manageHidden: boolean;
  readonly setManageHidden: (value: boolean) => void;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeBlocked: boolean;
  readonly runtimeModeChoices: ReadonlyArray<RuntimeModeChoice>;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly promptTraits: ReturnType<typeof getPromptControlledTraits>;
  readonly displayedModelSelection: ModelSelection | null;
  readonly reportedModelSelection: ModelSelection | null;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly hasCustomProviderFilter: boolean;
  readonly pendingModel: ModelOption | null;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => boolean;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
  /** The provider whose catalog for this folder the picker keeps fresh. */
  readonly workspaceScan: { readonly instanceId: ProviderInstanceId; readonly cwd: string } | null;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const gt = useGT();
  const messages = useMessages();
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
            serverConfigForCwd(config, props.cwd),
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
  const [userProviderFilter, setUserProviderFilter] = useState<string | null | undefined>(
    undefined,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [pendingOptions, setPendingOptions] = useState<{
    readonly modelKey: string;
    readonly options: ReadonlyArray<ProviderOptionSelection>;
  } | null>(null);
  const [pendingRuntimeMode, setPendingRuntimeMode] = useState<RuntimeMode | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPromptEdit | null>(null);
  const promptDraftKey = props.promptDraftKey ?? null;
  const selectedModelKey = props.selectedModel
    ? modelFavoriteKey(props.selectedModel.instanceId, props.selectedModel.model)
    : null;
  const activePendingOptions =
    pendingOptions !== null && pendingOptions.modelKey === selectedModelKey
      ? filterPendingOptionSelections(pendingOptions.options, props.optionDescriptors)
      : null;
  const activePendingPrompt =
    pendingPrompt !== null &&
    (pendingModel !== null || activePendingOptions?.some(({ id }) => id === pendingPrompt.optionId))
      ? resolvePendingPrompt(pendingPrompt, promptDraftKey, props.prompt)
      : null;
  const mergedOptions =
    activePendingOptions !== null && activePendingOptions.length > 0
      ? mergePendingOptionSelections(
          props.selectedModel?.options,
          activePendingOptions,
          props.optionDescriptors,
        )
      : null;
  const displayedPrompt = activePendingPrompt ?? props.prompt;
  const defaultProviderFilter = resolveDefaultProviderFilter({
    providerGroups,
    favoriteKeys,
    ...(props.lockedProviderInstanceId
      ? { lockedProviderInstanceId: props.lockedProviderInstanceId }
      : {}),
    favoritesFilter: FAVORITES_PROVIDER_FILTER,
  });
  const providerFilter = resolveEffectiveProviderFilter({
    userFilter: userProviderFilter,
    defaultFilter: defaultProviderFilter,
    searchQuery,
    manageHidden,
    favoritesFilter: FAVORITES_PROVIDER_FILTER,
  });

  const isApplied = (option: ModelOption) =>
    option.selection.instanceId === props.selectedModel?.instanceId &&
    option.selection.model === props.selectedModel.model;
  const isDisplayed = (option: ModelOption) =>
    pendingModel ? option.key === pendingModel.key : isApplied(option);

  const displayedDescriptors = pendingModel
    ? resolveProviderOptionDescriptors({
        capabilities: pendingModel.capabilities,
        selections: pendingModel.selection.options,
      })
    : overlayPendingOptionDescriptors(props.optionDescriptors, activePendingOptions);
  const promptTraits = getPromptControlledTraits(displayedDescriptors, displayedPrompt);
  const displayedInstanceId = pendingModel?.selection.instanceId ?? props.selectedModel?.instanceId;
  const runtimeModeChoices = withManagedRuntimeModeLimits(
    runtimeModeChoicesForSupportedModes(
      selectedProviderRuntimeModes(
        displayedInstanceId,
        serverConfigForCwd(config, props.cwd)?.providers ?? [],
      ) ?? pendingModel?.supportedRuntimeModes,
    ),
    [config?.managedPolicy],
    messages,
  );
  const stagedRuntimeMode = resolvePendingRuntimeMode(pendingRuntimeMode, runtimeModeChoices);
  const compatibleRuntimeMode =
    stagedRuntimeMode ?? compatibleRuntimeModeForChoices(props.runtimeMode, runtimeModeChoices);

  const hasLegacyModels = props.providerGroups.some((group) =>
    group.models.some((model) => model.isLegacy),
  );
  const commitPendingModel = () => {
    if (stagedRuntimeMode === undefined) {
      Dialog.alert(
        gt("Permission mode unavailable"),
        gt("Choose a permission mode supported by this model and workspace."),
      );
      return false;
    }
    if (pendingModel) {
      if (!canCommitPendingModel(pendingModel, props.providerGroups)) {
        Dialog.alert(
          gt("Model unavailable"),
          gt("Set up this provider on web or desktop, or select another model."),
        );
        return false;
      }
      void Haptics.selectionAsync();
      if (pendingModel.selection.options) {
        rememberModelOptions(
          pendingModel.selection.instanceId,
          pendingModel.selection.model,
          pendingModel.selection.options,
        );
      }
      props.onSelectModel(pendingModel);
    } else if (mergedOptions !== null) {
      props.onUpdateOptionSelections(mergedOptions);
    }
    if (activePendingPrompt !== null && activePendingPrompt !== props.prompt)
      props.onPromptChange(activePendingPrompt);
    if (stagedRuntimeMode !== null && stagedRuntimeMode !== props.runtimeMode)
      props.onUpdateRuntimeMode(stagedRuntimeMode);
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
        setPendingPrompt({
          draftKey: promptDraftKey,
          basePrompt: props.prompt,
          optionId: id,
          value: change.prompt,
        });
      }
    }
    const next = change
      ? (change.modelOptions ?? [])
      : applyProviderOptionSelection(displayedDescriptors, { id, value });
    if (!next) {
      return;
    }
    if (pendingModel) {
      setPendingModel({
        ...pendingModel,
        selection: { ...pendingModel.selection, options: next },
      });
    } else if (selectedModelKey !== null) {
      const edit = next.find((option) => option.id === id);
      if (!edit) return;
      setPendingOptions((current) => ({
        modelKey: selectedModelKey,
        options: mergePendingOptionSelections(
          current?.modelKey === selectedModelKey ? current.options : undefined,
          [edit],
        ),
      }));
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
    if (pendingModel ? option.key !== pendingModel.key : !isApplied(option)) {
      setPendingPrompt(null);
      setPendingOptions(null);
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

  const environmentId = props.environmentId;
  // Like the web picker's open tab: scanning every provider would spawn a probe per provider.
  const scannedInstanceId =
    providerFilter !== null && providerFilter !== FAVORITES_PROVIDER_FILTER
      ? ProviderInstanceId.make(providerFilter)
      : props.providerInstanceId;
  const workspaceScan =
    props.cwd && scannedInstanceId ? { instanceId: scannedInstanceId, cwd: props.cwd } : null;

  const value = {
    environmentId,
    providerInstanceId: props.providerInstanceId,
    providerGroups,
    manageHidden,
    setManageHidden,
    toggleHidden,
    pendingHiddenKeys,
    runtimeMode: compatibleRuntimeMode,
    runtimeModeBlocked: stagedRuntimeMode === undefined,
    runtimeModeChoices,
    onUpdateRuntimeMode: (mode) => setPendingRuntimeMode(mode === props.runtimeMode ? null : mode),
    displayedDescriptors,
    promptTraits,
    displayedModelSelection:
      pendingModel?.selection ??
      (mergedOptions !== null && props.selectedModel
        ? { ...props.selectedModel, options: mergedOptions }
        : props.selectedModel),
    reportedModelSelection: pendingModel ? null : (props.reportedModelSelection ?? null),
    favoriteKeys,
    favoritesLoaded,
    providerExpansionOverrides,
    hasLegacyModels,
    hasCustomProviderFilter: userProviderFilter !== undefined && providerFilter !== null,
    pendingModel,
    providerFilter,
    searchQuery,
    showLegacy: showLegacyToggle,
    applyOptionChange,
    commitPendingModel,
    isApplied,
    isDisplayed,
    pressModel,
    setProviderFilter: setUserProviderFilter,
    setSearchQuery,
    setShowLegacy: setShowLegacyToggle,
    toggleProvider,
    toggleFavorite,
    workspaceScan,
  } satisfies ThreadSettingsSessionValue;

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {environmentId && workspaceScan ? (
        <ProviderWorkspaceSnapshotScan
          key={workspaceScan.instanceId}
          environmentId={environmentId}
          instanceId={workspaceScan.instanceId}
          cwd={workspaceScan.cwd}
        />
      ) : null}
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

/** A project's own provider config can add models only its workspace scan lists. */
function ProviderWorkspaceSnapshotScan(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
}) {
  useAtomMount(providerWorkspaceSnapshotRefresh(props));
  return null;
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

type ThreadSettingsProviderCatalog = {
  readonly key: string;
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly models: ReadonlyArray<ModelOption>;
};

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
    }
  | {
      readonly kind: "subProvider";
      readonly key: string;
      readonly expansionKey: string;
      readonly label: string;
      readonly detail: string | undefined;
      readonly collapsed: boolean;
      readonly modelCount: number;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
    }
  | {
      readonly kind: "empty";
      readonly key: "empty";
    };

function ThreadSettingsModelListRow(props: {
  readonly option: ModelOption;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const session = useThreadSettingsSession();
  const onPress = () => session.pressModel(props.option);

  return (
    <ModelRow
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
      isFavorite={session.favoriteKeys.has(props.option.key)}
      favoritesLoaded={session.favoritesLoaded}
      onToggleFavorite={() => session.toggleFavorite(props.option)}
      onToggleHidden={
        session.manageHidden && props.option.canHide
          ? () => session.toggleHidden(props.option)
          : undefined
      }
      hiddenUpdatePending={session.pendingHiddenKeys.has(props.option.key)}
      option={props.option}
      selected={session.isDisplayed(props.option)}
    />
  );
}

function ThreadSettingsProviderListHeader(props: {
  readonly provider: ThreadSettingsProviderCatalog;
}) {
  const session = useThreadSettingsSession();
  const onToggle = () => session.toggleProvider(props.provider.key);

  return (
    <ProviderHeader
      collapsible={props.provider.collapsible}
      collapsed={props.provider.collapsed}
      driver={props.provider.driver}
      iconUrl={props.provider.iconUrl}
      label={props.provider.label}
      modelCount={props.provider.modelCount}
      onToggle={onToggle}
    />
  );
}

function ThreadSettingsSubProviderListHeader(props: {
  readonly item: Extract<ThreadSettingsCatalogItem, { kind: "subProvider" }>;
}) {
  const session = useThreadSettingsSession();
  const onToggle = () => session.toggleProvider(props.item.expansionKey);

  return (
    <ProviderHeader
      nested
      collapsible={props.item.detail === undefined}
      collapsed={props.item.collapsed}
      detail={props.item.detail}
      driver={undefined}
      iconUrl={undefined}
      label={props.item.label}
      modelCount={props.item.modelCount}
      onToggle={onToggle}
    />
  );
}

const modelItems = (models: ReadonlyArray<ModelOption>) =>
  models.map((option, index) => ({
    kind: "model" as const,
    key: `model:${option.key}`,
    option,
    isFirst: index === 0,
    isLast: index === models.length - 1,
  }));

/**
 * A provider whose models run on several backends, such as fx, lists each
 * backend under its own collapsible heading; the thread's backend opens.
 * Search and Favorites stay flat.
 */
function subProviderCatalogItems(
  session: ThreadSettingsSessionValue,
  group: ProviderGroup,
  models: ReadonlyArray<ModelOption>,
): ReadonlyArray<ThreadSettingsCatalogItem> | null {
  if (
    !group.subProviders?.length ||
    session.searchQuery.trim().length > 0 ||
    session.providerFilter === FAVORITES_PROVIDER_FILTER
  ) {
    return null;
  }
  const { ungrouped, groups } = groupModelsBySubProvider(
    models,
    group.subProviders,
    (option) => option.subtitle,
  );
  return [
    ...modelItems(ungrouped),
    ...groups.flatMap(({ subProvider, models: backendModels }) => {
      const expansionKey = `${group.providerKey}:sub-provider:${subProvider.name}`;
      const collapsed =
        subProvider.unavailableReason !== undefined ||
        providerSectionIsCollapsed({
          defaultExpanded: backendModels.some(session.isApplied),
          hasExpansionOverride: session.providerExpansionOverrides.has(expansionKey),
          isNarrowed: false,
        });
      return [
        {
          kind: "subProvider" as const,
          key: `sub-provider:${expansionKey}`,
          expansionKey,
          label: subProvider.name,
          detail: subProvider.unavailableReason,
          collapsed,
          modelCount: backendModels.length,
        },
        // The heading names the backend, so rows drop it.
        ...(collapsed
          ? []
          : modelItems(backendModels.map((option) => ({ ...option, subtitle: "" })))),
      ];
    }),
  ];
}

function buildThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
  resolve: MessageResolver,
  locale: string,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  const favoritesSelected = session.providerFilter === FAVORITES_PROVIDER_FILTER;
  if (favoritesSelected && !session.searchQuery.trim() && !session.manageHidden) {
    return modelItems(
      session.providerGroups.flatMap((group) =>
        group.models.filter((model) => session.favoriteKeys.has(model.key)),
      ),
    );
  }
  return session.providerGroups.flatMap((group) => {
    if (
      session.providerFilter !== null &&
      session.providerFilter !== FAVORITES_PROVIDER_FILTER &&
      group.providerKey !== session.providerFilter
    ) {
      return [];
    }
    const driver = group.models[0]?.providerDriver ?? group.providerKey;
    const catalogModels =
      session.manageHidden ||
      session.showLegacy ||
      session.providerFilter === FAVORITES_PROVIDER_FILTER
        ? group.models
        : group.models.filter(
            (model) =>
              !model.isLegacy || session.isDisplayed(model) || session.favoriteKeys.has(model.key),
          );
    const visibleModels = favoritesFirst(
      catalogModels.filter(
        (model) =>
          (session.providerFilter !== FAVORITES_PROVIDER_FILTER ||
            session.favoriteKeys.has(model.key)) &&
          modelMatchesCatalogQuery({
            model,
            providerLabel: group.providerLabel,
            query: session.searchQuery,
          }),
      ),
      session.favoriteKeys,
    );
    const updateRequiredNotice =
      group.updateRequired && session.providerFilter !== FAVORITES_PROVIDER_FILTER
        ? formatProviderUpdateRequiredNotice(
            group.updateRequired,
            session.searchQuery,
            resolve,
            locale,
          )
        : null;
    if (visibleModels.length === 0 && !updateRequiredNotice) {
      return [];
    }
    const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
    const containsAppliedSelection = group.models.some(session.isApplied);
    const isNarrowed = session.providerFilter !== null || session.searchQuery.trim().length > 0;
    const collapsible = !isNarrowed;
    const collapsed = providerSectionIsCollapsed({
      defaultExpanded: isPrimary || containsAppliedSelection,
      hasExpansionOverride: session.providerExpansionOverrides.has(group.providerKey),
      isNarrowed,
    });
    const provider: ThreadSettingsProviderCatalog = {
      key: group.providerKey,
      driver,
      iconUrl: group.models[0]?.providerIconUrl,
      label: group.providerLabel,
      collapsible,
      collapsed,
      modelCount: visibleModels.length,
      models: collapsed ? [] : visibleModels,
    };
    return [
      {
        kind: "provider" as const,
        key: `provider:${group.providerKey}`,
        provider,
      },
      ...((collapsed ? null : subProviderCatalogItems(session, group, provider.models)) ??
        modelItems(provider.models)),
      ...(!collapsed && updateRequiredNotice
        ? [
            {
              kind: "notice" as const,
              key: `notice:${group.providerKey}`,
              text: updateRequiredNotice,
            },
          ]
        : []),
    ];
  });
}

function SettingSegments(props: {
  readonly label: string | undefined;
  readonly trailing?: ReactNode;
  readonly vertical?: boolean;
  readonly choices: ReadonlyArray<{
    readonly value: string | boolean;
    readonly label: string;
    readonly icon?: AppSymbolName | undefined;
    readonly description?: string | undefined;
  }>;
  readonly selected: string | boolean | undefined;
  readonly onChange: (value: string | boolean) => void;
}) {
  const selectedDescription = props.choices
    .find((choice) => choice.value === props.selected)
    ?.description?.trim();

  return (
    <View className={props.vertical ? undefined : "gap-2"}>
      {props.label || props.trailing ? (
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          {props.label ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {props.label}
            </Text>
          ) : null}
          {props.trailing}
        </View>
      ) : null}
      <View
        className={
          props.vertical
            ? "border-t border-border-subtle"
            : cn(
                "min-h-11 flex-row gap-1 rounded-xl border border-border-subtle bg-subtle p-1",
                !props.label && "min-h-[44px]",
              )
        }
      >
        {props.choices.map((choice) => {
          const selected = choice.value === props.selected;
          return (
            <Pressable
              key={String(choice.value)}
              accessibilityHint={choice.description}
              accessibilityLabel={choice.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              className={cn(
                "items-center rounded-lg",
                props.vertical
                  ? "min-h-[44px] flex-row justify-between gap-2 px-2 py-1"
                  : "min-h-9 min-w-10 flex-1 flex-row justify-center gap-1 px-1.5 py-1",
                selected && "bg-grouped-card",
              )}
              onPress={() => props.onChange(choice.value)}
            >
              {choice.icon ? (
                <View
                  className="shrink-0"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <SymbolView
                    name={choice.icon}
                    size={12}
                    tintColorClassName={selected ? "accent-foreground" : "accent-foreground-muted"}
                  />
                </View>
              ) : null}
              <Text
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                numberOfLines={1}
                className={cn(
                  "text-sm",
                  props.vertical
                    ? "min-w-0 flex-1 text-foreground"
                    : "min-w-0 shrink text-center text-foreground-muted",
                  selected && "font-t3-medium text-foreground",
                )}
              >
                {choice.label}
              </Text>
              {props.vertical && selected ? (
                <SymbolView name="checkmark" size={14} tintColorClassName="accent-foreground" />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {selectedDescription ? (
        <Text className={cn("text-xs leading-4 text-foreground-muted", props.vertical && "pt-2")}>
          {selectedDescription}
        </Text>
      ) : null}
    </View>
  );
}

const PICKER_OPTIONS_COLUMN_WIDTH = 204;
const FAST_SPEED_ICON = { ios: "bolt.fill", android: "bolt" } satisfies AppSymbolName;
const PICKER_PROVIDER_RAIL_WIDTH = 56;
const PICKER_TWO_COLUMN_MIN_WIDTH = PICKER_OPTIONS_COLUMN_WIDTH + PICKER_PROVIDER_RAIL_WIDTH + 300;

function ThreadSettingsPickerLayout(props: {
  readonly catalog: ReactNode;
  readonly renderSearch: (withIcon: boolean) => ReactNode;
  readonly searching: boolean;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const session = useThreadSettingsSession();
  const insets = useSafeAreaInsets();
  const [hasRoomForColumns, setHasRoomForColumns] = useState(false);
  const bottomInset = props.searching ? 0 : insets.bottom;
  const configs = useAtomValue(environmentServerConfigsAtom);
  const activeProviderInstanceId =
    session.displayedModelSelection?.instanceId ?? session.providerInstanceId;
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === activeProviderInstanceId) ?? null)
    : null;
  const { reasoning, speed, ultracode, extraOptions } = partitionThreadSettingsDescriptors(
    session.displayedDescriptors,
  );
  const speedChoices =
    speed?.type === "select"
      ? selectableChoices(speed).map((choice) => ({
          value: choice.id,
          icon: choice.id === "priority" ? FAST_SPEED_ICON : undefined,
          label:
            choice.id === "default"
              ? gt("Standard")
              : choice.id === "priority"
                ? gt("Fast")
                : choice.label,
        }))
      : [
          { value: false, label: gt("Standard") },
          { value: true, label: gt("Fast"), icon: FAST_SPEED_ICON },
        ];
  const runtimeLabel = session.runtimeModeChoices.find(
    (choice) => choice.mode === session.runtimeMode,
  )?.label;
  const currentValue = (descriptor: ProviderOptionDescriptor) =>
    getProviderOptionCurrentValue(
      descriptor,
      session.displayedModelSelection,
      session.reportedModelSelection,
    );
  const ultracodeActive = ultracode ? currentValue(ultracode) === true : false;
  const ultracodeToggle = ultracode ? (
    <Pressable
      accessibilityLabel={ultracode.label}
      accessibilityRole="switch"
      accessibilityState={{ checked: ultracodeActive }}
      hitSlop={{ top: 10, bottom: 2, left: 8, right: 8 }}
      className={cn(
        "min-h-9 flex-row items-center gap-1.5 rounded-lg border px-2.5 py-1 active:opacity-70",
        ultracodeActive ? "border-primary bg-primary" : "border-border-subtle bg-subtle",
      )}
      onPress={() => {
        void Haptics.selectionAsync();
        session.applyOptionChange(ultracode.id, !ultracodeActive);
      }}
    >
      <SymbolView
        name="flowchart"
        size={13}
        tintColorClassName={
          ultracodeActive ? "accent-primary-foreground" : "accent-foreground-muted"
        }
      />
      <Text
        numberOfLines={1}
        className={cn(
          "text-xs font-t3-medium",
          ultracodeActive ? "text-primary-foreground" : "text-foreground-muted",
        )}
      >
        {ultracode.label}
      </Text>
      {ultracodeActive ? (
        <SymbolView name="checkmark" size={11} tintColorClassName="accent-primary-foreground" />
      ) : null}
    </Pressable>
  ) : null;
  const reasoningUltrathinkControlled =
    reasoning !== null &&
    reasoning.id === session.promptTraits.primarySelectDescriptor?.id &&
    session.promptTraits.ultrathinkPromptControlled;

  const footerControls = (
    <View className={cn("flex-row gap-2", hasRoomForColumns ? "items-center" : "items-end")}>
      {speed && !props.searching ? (
        <View className="w-40 shrink-0">
          <SettingSegments
            label={hasRoomForColumns ? undefined : gt("Speed")}
            choices={speedChoices}
            selected={currentValue(speed)}
            onChange={(value) => session.applyOptionChange(speed.id, value)}
          />
        </View>
      ) : null}
      {hasRoomForColumns ? (
        <View className="min-w-0 flex-1">{props.renderSearch(true)}</View>
      ) : null}
      {!props.searching ? (
        <View className={hasRoomForColumns ? "w-[184px] shrink-0" : "min-w-0 flex-1 gap-2"}>
          {!hasRoomForColumns ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {gt("Permissions")}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[
              gt("Permissions"),
              session.runtimeModeBlocked
                ? gt("Permission mode unavailable")
                : runtimeLabel === undefined
                  ? undefined
                  : m(runtimeLabel),
            ]
              .filter(Boolean)
              .join(", ")}
            className={cn(
              "min-h-11 flex-row items-center gap-2 rounded-xl bg-grouped-card px-3 py-1",
              hasRoomForColumns && "min-h-[44px]",
              session.runtimeModeBlocked && "border border-warning",
            )}
            onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
          >
            <SymbolView
              name={PERMISSION_SYMBOLS[session.runtimeMode]}
              size={14}
              tintColorClassName="accent-foreground-muted"
            />
            <Text
              numberOfLines={1}
              className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
            >
              {session.runtimeModeBlocked
                ? gt("Permission mode unavailable")
                : runtimeLabel === undefined
                  ? undefined
                  : m(runtimeLabel)}
            </Text>
            <SymbolView
              name="chevron.right"
              size={12}
              tintColorClassName="accent-foreground-muted"
            />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
  const modelOptions = (
    <>
      {reasoning ? (
        <SettingSegments
          label={gt("Reasoning")}
          trailing={ultracodeToggle}
          vertical={hasRoomForColumns}
          choices={(reasoningUltrathinkControlled
            ? reasoning.options.filter(
                (choice) =>
                  !reasoning.promptInjectedValues?.includes(choice.id) ||
                  choice.id === "ultrathink",
              )
            : selectableChoices(reasoning)
          ).map((choice) => ({
            value: choice.id,
            label: choice.label,
            description: choice.description,
          }))}
          selected={reasoningUltrathinkControlled ? "ultrathink" : currentValue(reasoning)}
          onChange={(value) => {
            if (
              reasoning.id === session.promptTraits.primarySelectDescriptor?.id &&
              session.promptTraits.ultrathinkInBodyText
            ) {
              Dialog.alert(
                gt("Reasoning controlled by prompt"),
                gt(
                  'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                ),
              );
              return;
            }
            session.applyOptionChange(reasoning.id, value);
          }}
        />
      ) : ultracodeToggle ? (
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {gt("Workflow")}
          </Text>
          {ultracodeToggle}
        </View>
      ) : null}
      {extraOptions.length ? (
        <View className="overflow-hidden rounded-xl bg-grouped-card">
          {extraOptions.map((descriptor, index) =>
            descriptor.type === "select" ? (
              <DisclosureRow
                key={descriptor.id}
                label={descriptor.label}
                value={getProviderOptionCurrentLabel(
                  descriptor,
                  session.displayedModelSelection,
                  session.reportedModelSelection,
                )}
                isLast={index === extraOptions.length - 1}
                onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
              />
            ) : (
              <SwitchRow
                key={descriptor.id}
                label={descriptor.label}
                value={currentValue(descriptor) === true}
                isLast={index === extraOptions.length - 1}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            ),
          )}
        </View>
      ) : null}
    </>
  );

  return (
    <View
      className="min-h-0 flex-1"
      onLayout={(event) => {
        setHasRoomForColumns(event.nativeEvent.layout.width >= PICKER_TWO_COLUMN_MIN_WIDTH);
      }}
      style={{ paddingBottom: hasRoomForColumns ? bottomInset : 0 }}
    >
      {!hasRoomForColumns && !props.searching ? (
        <ScrollView
          bounces={false}
          className={cn(
            "grow-0 shrink border-b border-border-subtle",
            reasoning ? "max-h-[50%]" : "max-h-[45%]",
          )}
          contentContainerClassName="gap-3 px-3 pb-4 pt-3"
          showsVerticalScrollIndicator={false}
        >
          <ChatGptSharingStatus provider={selectedProvider} />
          {footerControls}
          {modelOptions}
        </ScrollView>
      ) : null}
      <View className="min-h-0 flex-1 flex-row">
        {props.catalog}
        {hasRoomForColumns &&
        !props.searching &&
        (reasoning || ultracode || extraOptions.length) ? (
          <ScrollView
            bounces={false}
            className="grow-0 shrink-0 border-l border-border-subtle"
            contentContainerClassName="gap-3 px-3 pb-3 pt-1.5"
            style={{ width: PICKER_OPTIONS_COLUMN_WIDTH }}
          >
            {modelOptions}
          </ScrollView>
        ) : null}
      </View>
      {hasRoomForColumns ? (
        <View className="shrink-0 gap-2 border-t border-border-subtle px-3 py-2">
          {!props.searching ? <ChatGptSharingStatus provider={selectedProvider} /> : null}
          {footerControls}
        </View>
      ) : (
        <View className="shrink-0" style={{ paddingBottom: bottomInset }}>
          <View className="border-t border-border-subtle px-3 py-2">
            {props.renderSearch(false)}
          </View>
        </View>
      )}
    </View>
  );
}

function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const session = useThreadSettingsSession();
  const barOverlap = useBarOverlap();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const [searchFocused, setSearchFocused] = useState(false);
  const searching = searchFocused && keyboardVisible;
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshProviderCatalog = createProviderCatalogRefreshRunner(refreshProvidersCommand);
  const registry = use(RegistryContext);
  const refreshModelCatalog = useEffectEvent(() => {
    const environmentId = session.environmentId;
    if (!environmentId) return;
    // An older server drops the field and probes every provider.
    const config = registry.get(environmentServerConfigsAtom).get(environmentId);
    if (config?.environment.capabilities.modelCatalogRefresh !== true) return;
    void refreshProvidersCommand({ environmentId, input: { modelCatalogOnly: true } });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for newly released models when the model list opens
  useEffect(() => {
    refreshModelCatalog();
  }, []);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshProviders = () => {
    if (!session.environmentId || isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    const environmentId = session.environmentId;
    const workspaceScan = session.workspaceScan;
    void refreshProviderCatalog(environmentId)
      .then(async (result) => {
        // A project's own models are read per folder, so the machine refresh alone keeps them stale.
        // A failed folder read keeps its previous models and retries, so only the machine result alerts.
        if (result._tag === "Success" && workspaceScan) {
          await refreshProvidersCommand({
            environmentId,
            input: { ...workspaceScan, fresh: true },
          });
        }
        return result;
      })
      .then((result) => {
        setIsRefreshingProviders(false);
        const error = providerCatalogRefreshError(result);
        if (error) Dialog.alert(gt("Could not refresh models"), error);
      });
  };
  const [listLoaded, setListLoaded] = useState(false);
  // Android can drop the first frame of a reduced-motion fade, leaving rows invisible.
  const reducedMotion = useReducedMotion();
  const reduceMotionEnabled = useReduceMotionEnabled();
  const animationsReady = listLoaded && !reducedMotion && !reduceMotionEnabled;
  const catalogItems = buildThreadSettingsCatalogItems(session, m, locale);
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const listItems = [
    ...(catalogItems.length === 0 ? ([{ kind: "empty", key: "empty" }] as const) : catalogItems),
  ] satisfies ReadonlyArray<ThreadSettingsCatalogItem>;
  const renderCatalogItem = (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
    const item = itemProps.item;
    let content: ReactNode;

    if (item.kind === "provider") {
      content = <ThreadSettingsProviderListHeader provider={item.provider} />;
    } else if (item.kind === "subProvider") {
      content = <ThreadSettingsSubProviderListHeader item={item} />;
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
              ? gt("No favorite models")
              : hasActiveCatalogFilter
                ? gt("No matching models")
                : gt("No available models")}
          </Text>
        </View>
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

  const catalog = (
    <View className="min-h-0 min-w-0 flex-1 flex-row">
      <ScrollView
        className="grow-0 shrink-0 border-r border-border-subtle"
        contentContainerClassName="items-center gap-1 p-1"
        keyboardShouldPersistTaps="always"
        style={{ width: PICKER_PROVIDER_RAIL_WIDTH }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Favorites")}
          accessibilityState={{ selected: session.providerFilter === FAVORITES_PROVIDER_FILTER }}
          className={cn(
            "size-[44px] items-center justify-center rounded-lg",
            session.providerFilter === FAVORITES_PROVIDER_FILTER && "bg-subtle-strong",
          )}
          onPress={() => session.setProviderFilter(FAVORITES_PROVIDER_FILTER)}
        >
          <SymbolView name="star.fill" size={17} tintColorClassName="accent-foreground" />
        </Pressable>
        {session.providerGroups.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("All providers")}
            accessibilityState={{ selected: session.providerFilter === null }}
            className={cn(
              "size-[44px] items-center justify-center rounded-lg",
              session.providerFilter === null && "bg-subtle-strong",
            )}
            onPress={() => session.setProviderFilter(null)}
          >
            <SymbolView name="square.grid.2x2" size={16} tintColorClassName="accent-foreground" />
          </Pressable>
        ) : null}
        {session.providerGroups.map((group) => (
          <Pressable
            key={group.providerKey}
            accessibilityRole="button"
            accessibilityLabel={group.providerLabel}
            accessibilityState={{ selected: session.providerFilter === group.providerKey }}
            className={cn(
              "size-[44px] items-center justify-center rounded-lg",
              session.providerFilter === group.providerKey && "bg-subtle-strong",
            )}
            onPress={() => session.setProviderFilter(group.providerKey)}
          >
            <ProviderIcon
              provider={group.models[0]?.providerDriver}
              iconUrl={group.models[0]?.providerIconUrl}
              size={17}
            />
          </Pressable>
        ))}
      </ScrollView>
      <View className="min-h-0 min-w-0 flex-1">
        {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content is outside workspace columns. */}
        <AnimatedLegendList
          alwaysBounceVertical
          automaticallyAdjustsScrollIndicatorInsets={false}
          className="flex-1 bg-sheet"
          style={READABLE_WIDTH_STYLE}
          contentContainerStyle={{ paddingTop: 4 }}
          contentInsetAdjustmentBehavior="never"
          data={listItems}
          estimatedItemSize={ROW_MIN_HEIGHT.item}
          extraData={animationsReady}
          getItemType={(item) => item.kind}
          itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
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
      </View>
    </View>
  );
  const renderSearch = (withIcon: boolean) => {
    const input = (
      <AppTextInput
        accessibilityLabel={gt("Search models")}
        autoCapitalize="none"
        autoCorrect={false}
        className={cn(
          "text-sm text-foreground",
          withIcon
            ? "min-h-[44px] min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 pl-2"
            : "min-h-11 rounded-lg bg-grouped-card px-3",
        )}
        onBlur={() => setSearchFocused(false)}
        onChangeText={session.setSearchQuery}
        onFocus={() => setSearchFocused(true)}
        placeholder={gt("Search models")}
        returnKeyType="search"
        value={session.searchQuery}
      />
    );
    return withIcon ? (
      <View className="flex-row items-center rounded-lg bg-grouped-card px-3">
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <SymbolView
            name="magnifyingglass"
            size={15}
            tintColorClassName="accent-foreground-muted"
          />
        </View>
        {input}
      </View>
    ) : (
      input
    );
  };

  return (
    <KeyboardAvoidingView
      automaticOffset
      behavior="padding"
      className="flex-1 bg-sheet"
      style={{ paddingTop: barOverlap }}
    >
      <ThreadSettingsPickerLayout
        catalog={catalog}
        renderSearch={renderSearch}
        searching={searching}
        onOpenSubmenu={props.onOpenSubmenu}
      />
    </KeyboardAvoidingView>
  );
}

function ThreadSettingsChoiceContent(props: {
  readonly submenu: Extract<ThreadSettingsSubmenuPage, { readonly kind: "descriptor" }>;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const session = useThreadSettingsSession();
  const activeDescriptor = session.displayedDescriptors.find(
    (descriptor) => descriptor.type === "select" && descriptor.id === props.submenu.id,
  );

  const submenuContent =
    activeDescriptor?.type === "select"
      ? {
          rows: (session.promptTraits.ultrathinkPromptControlled &&
          activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
            ? activeDescriptor.options.filter(
                (choice) =>
                  !activeDescriptor.promptInjectedValues?.includes(choice.id) ||
                  choice.id === "ultrathink",
              )
            : selectableChoices(activeDescriptor)
          ).map((choice) => ({
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
                  gt("Reasoning controlled by prompt"),
                  gt(
                    'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                  ),
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
      style={READABLE_WIDTH_STYLE}
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

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: Extract<ThreadSettingsSubmenuPage, { readonly kind: "descriptor" }> & {
    readonly title: string;
  };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const PermissionsSheetSurface = withUniwind(SafeAreaView, {
  style: { fromClassName: "className" },
});
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

function ThreadSettingsModelsScreen() {
  const gt = useGT();
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const m = useMessages();
  const reducedMotion = useReducedMotion();
  const reduceMotionEnabled = useReduceMotionEnabled();
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const dismissPermissions = () => setPermissionsOpen(false);
  const hasCustomCatalogFilter = session.hasCustomProviderFilter || session.showLegacy;
  const commitAndClose = useEffectEvent(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  });
  const providerFilters = [
    { id: "all-providers", title: gt("All providers"), value: null },
    { id: "favorites", title: gt("Favorites"), value: FAVORITES_PROVIDER_FILTER },
    ...session.providerGroups.map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      value: group.providerKey,
    })),
  ];

  return (
    <>
      <AppBar
        title={gt("Model selector")}
        onClose={presentation.onClose}
        closeAccessibilityLabel={gt("Cancel thread settings")}
        menus={[
          {
            title: gt("Model filters"),
            icon: hasCustomCatalogFilter
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease",
            items: [
              {
                id: "manage-hidden",
                title: gt("Manage hidden models"),
                selected: session.manageHidden,
                onPress: () => session.setManageHidden(!session.manageHidden),
              },
              {
                id: "provider",
                title: gt("Provider"),
                items: providerFilters.map((filter) => ({
                  id: filter.id,
                  title: filter.title,
                  selected: session.providerFilter === filter.value,
                  onPress: () => session.setProviderFilter(filter.value),
                })),
              },
              ...(session.hasLegacyModels
                ? [
                    {
                      id: "show-legacy",
                      title: gt("Show legacy models"),
                      selected: session.showLegacy,
                      onPress: () => session.setShowLegacy(!session.showLegacy),
                    },
                  ]
                : []),
            ],
          },
        ]}
        optionsVersion={[
          session.manageHidden,
          session.providerFilter,
          session.providerGroups.map((group) => group.providerKey),
          session.showLegacy,
          session.hasLegacyModels,
        ]}
        confirm={{
          label: gt("Apply model settings"),
          onPress: commitAndClose,
        }}
        hideBottomBorder
      />
      <ScreenContent>
        <ThreadSettingsMainContent
          onOpenSubmenu={(submenu) => {
            if (submenu.kind === "runtime") {
              setPermissionsOpen(true);
              return;
            }
            const title =
              session.displayedDescriptors.find(
                (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
              )?.label ?? gt("Option");
            navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
          }}
        />
      </ScreenContent>
      <Modal
        animationType={reducedMotion || reduceMotionEnabled ? "none" : "fade"}
        transparent
        visible={permissionsOpen}
        onRequestClose={dismissPermissions}
      >
        <SafeAreaProvider style={{ flex: 1 }}>
          <View className="flex-1 justify-end bg-black/60">
            <Pressable
              className="absolute inset-0"
              accessible={false}
              onPress={dismissPermissions}
            />
            <PermissionsSheetSurface
              accessibilityViewIsModal
              edges={["bottom"]}
              className="max-h-[80%] w-full max-w-[560px] self-center rounded-t-3xl bg-sheet px-4 pb-3 pt-2"
            >
              <View className="flex-row items-center justify-between">
                <Text
                  accessibilityRole="header"
                  className="pl-3 text-base font-t3-medium text-foreground"
                >
                  {gt("Permissions")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("Close permissions")}
                  className="size-11 items-center justify-center"
                  onPress={dismissPermissions}
                >
                  <SymbolView name="xmark" size={16} tintColorClassName="accent-foreground" />
                </Pressable>
              </View>
              <ScrollView bounces={false} className="grow-0 rounded-xl bg-grouped-card">
                {session.runtimeModeChoices.map((choice, index) => {
                  const label = m(choice.label);
                  const description = choice.disabledReason ?? m(choice.description);
                  return (
                    <Pressable
                      key={choice.mode}
                      accessibilityLabel={description ? `${label}. ${description}` : label}
                      accessibilityRole="radio"
                      accessibilityState={{
                        checked: choice.mode === session.runtimeMode,
                        disabled: choice.disabledReason !== undefined,
                      }}
                      disabled={choice.disabledReason !== undefined}
                      className={cn(
                        "min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-subtle",
                        index !== session.runtimeModeChoices.length - 1 &&
                          "border-b border-border-subtle",
                        choice.disabledReason !== undefined && "opacity-50",
                      )}
                      onPress={() => {
                        void Haptics.selectionAsync();
                        session.onUpdateRuntimeMode(choice.mode);
                        dismissPermissions();
                      }}
                    >
                      <SymbolView
                        name={PERMISSION_SYMBOLS[choice.mode]}
                        size={17}
                        tintColorClassName="accent-foreground"
                      />
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-medium text-foreground">{label}</Text>
                        {description ? (
                          <Text className="text-xs leading-4 text-foreground-muted">
                            {description}
                          </Text>
                        ) : null}
                      </View>
                      <View className="w-5 items-center">
                        {choice.mode === session.runtimeMode ? (
                          <SymbolView
                            name="checkmark"
                            size={16}
                            tintColorClassName="accent-foreground"
                          />
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </PermissionsSheetSurface>
          </View>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <AppBar title={route.params.title} onBack={() => navigation.goBack()} hideBottomBorder />
      <ScreenContent>
        <ThreadSettingsChoiceContent
          submenu={route.params}
          onSelected={() => navigation.goBack()}
        />
      </ScreenContent>
    </>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const screenOptions = useSheetStackOptions();
  const gt = useGT();
  const presentation = {
    onClose: props.onClose,
  };

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={screenOptions}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: gt("Thread settings") }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

export function ThreadSettingsPickerScreen(
  props: ThreadSettingsSessionProps & { readonly onClose: () => void },
) {
  return (
    <ThreadSettingsSessionProvider {...props}>
      <ThreadSettingsPickerNavigator onClose={props.onClose} />
    </ThreadSettingsSessionProvider>
  );
}

export function ExistingThreadSettingsRouteScreen({
  route,
}: StaticScreenProps<ExistingThreadSettingsRouteParams>) {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  // Reads the same environmentId/threadId params as the Thread route beneath it.
  const { selectedThread, selectedThreadDetailRef, selectedEnvironmentRuntime } =
    useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  // Streamed text would otherwise re-render the whole model picker on every delta.
  const structure = useQuietThreadStructure(selectedThreadDetailRef);
  const reportedModelSelection = useThreadReportedModelSelection(selectedThreadDetailRef);
  const threadKey = scopedThreadKey(route.params.environmentId, route.params.threadId);
  const draftSettings = useComposerDraftSettings(threadKey);
  const queuedRunEdit = useQueuedRunEdit(threadKey);
  // A queued edit can end while the sheet is open; the prompt then belongs to the thread's draft.
  const draftKey = activeComposerDraftKey(threadKey, route.params.draftKey, queuedRunEdit);
  const prompt = useComposerDraft(draftKey).text;

  if (!selectedThread) {
    return <View className="flex-1 bg-sheet" />;
  }

  const serverConfig = serverConfigForCwd(
    selectedEnvironmentRuntime?.serverConfig ?? null,
    selectedThreadCwd,
  );
  const modelSelection = draftSettings.modelSelection ?? selectedThread.modelSelection;
  const lockedProviderInstanceId = threadAllowsProviderSwitch({
    thread: selectedThread,
    projection: structure?.projection,
  })
    ? undefined
    : modelSelection.instanceId;
  const modelOptions = buildModelOptions(
    serverConfig,
    modelSelection,
    lockedProviderInstanceId,
    selectedThread.projectId,
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === modelSelection.instanceId &&
        option.selection.model === modelSelection.model,
    ) ?? null;
  const updateModelSelection = (selection: ModelSelection) =>
    selectThreadModel(route.params, selection);

  return (
    <ThreadSettingsPickerScreen
      environmentId={selectedThread.environmentId}
      projectId={selectedThread.projectId}
      cwd={selectedThreadCwd}
      providerInstanceId={modelSelection.instanceId}
      {...(lockedProviderInstanceId ? { lockedProviderInstanceId } : {})}
      providerGroups={groupByProvider(modelOptions)}
      selectedModel={modelSelection}
      promptDraftKey={draftKey}
      prompt={prompt}
      onPromptChange={(text) => setComposerDraftText(draftKey, text)}
      reportedModelSelection={reportedModelSelection}
      onSelectModel={(option) =>
        updateModelSelection(
          withStoredThreadModelOptions(
            withRememberedModelOptions(option.selection),
            selectedThread.modelSelection,
          ),
        )
      }
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: modelSelection.options,
      })}
      onUpdateOptionSelections={(options) => {
        rememberModelOptions(modelSelection.instanceId, modelSelection.model, options ?? []);
        updateModelSelection({ ...modelSelection, options });
      }}
      runtimeMode={draftSettings.runtimeMode ?? selectedThread.runtimeMode}
      onUpdateRuntimeMode={(runtimeMode) => updateComposerDraftSettings(threadKey, { runtimeMode })}
      onClose={() => navigation.goBack()}
    />
  );
}

/** RNS owns nested sheet dismissal; Reasoning and Runtime remain ordinary pushes. */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const optionDescriptors = resolveProviderOptionDescriptors({
    capabilities: flow.selectedModelOption?.capabilities,
    selections: flow.selectedModel?.options,
  });

  return (
    <ThreadSettingsPickerScreen
      environmentId={flow.selectedEnvironmentId}
      projectId={flow.selectedProject?.id ?? null}
      cwd={flow.workspaceCwd}
      {...(flow.selectedModel ? { providerInstanceId: flow.selectedModel.instanceId } : {})}
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      prompt={flow.prompt}
      onPromptChange={flow.setPrompt}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
      onClose={() => navigation.goBack()}
    />
  );
}

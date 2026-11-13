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

const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "antigravity",
]);
/** Keep measured size changes stable; let catalog mutations return underflowing filtered lists to the top. */
export const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
export const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
export const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
export const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
export const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);
export const THREAD_SETTINGS_OPTION_ENTER_TRANSITION = FadeIn.duration(140);
export const THREAD_SETTINGS_OPTION_EXIT_TRANSITION = FadeOut.duration(100);
const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);
export const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];
export const FAVORITES_PROVIDER_FILTER = "@favorites";
// Servers that predate `migrateModelPreferences` drop it and keep reporting null favorites.
export const attemptedMigrationGenerations = new Map<EnvironmentId, number>();
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      <ProviderIcon iconUrl={props.iconUrl} provider={props.driver} size={15} />
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
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
        accessibilityLabel={`${props.label}, ${props.modelCount} models`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 min-h-11 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60 android:min-h-12"
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityRole="header" className="mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1">
      {content}
    </View>
  );
}

export function DisclosureRow(props: {
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
        "min-h-11 flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14",
        !props.isLast && "border-b border-border-subtle",
      )}
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

export function SwitchRow(props: {
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

export type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" };

export type ThreadSettingsSessionProps = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
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

export type ThreadSettingsSessionValue = {
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
  readonly runtimeModeChoices: ReadonlyArray<RuntimeModeChoice>;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly promptTraits: ReturnType<typeof getPromptControlledTraits>;
  readonly displayedModelSelection: ModelSelection | null;
  readonly reportedModelSelection: ModelSelection | null;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
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
};

export const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

export function useThreadSettingsSession() {
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

export type ThreadSettingsCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
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
    }
  | {
      readonly kind: "options";
      readonly key: "options";
    };

export function ThreadSettingsModelListRow(props: {
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

export function ThreadSettingsProviderListHeader(props: {
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

export function buildThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
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
        ? formatProviderUpdateRequiredNotice(group.updateRequired, session.searchQuery)
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
      ...provider.models.map((option, index) => ({
        kind: "model" as const,
        key: `model:${option.key}`,
        option,
        isFirst: index === 0,
        isLast: index === provider.models.length - 1,
      })),
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

export type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

export function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

// With a Duo vertical bar, filter and search join cancel and confirm in the rail.
export function useThreadSettingsMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return useNativeMailSearchToolbar() && (metrics?.verticalBarEdge ?? "none") === "none";
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={route.params.title}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
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
  const theme = useUniwindTheme();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];
  const presentation = {
    onClose: props.onClose,
  };

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: Platform.OS === "android" ? "default" : "slide_from_right",
          contentStyle: { backgroundColor: solidSheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShown: Platform.OS !== "android",
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
          },
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
          scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
            ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
            : undefined,
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: "Thread settings" }}
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

  const serverConfig = selectedEnvironmentRuntime?.serverConfig ?? null;
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
    updateThreadDraftModelSelection(threadKey, selection, serverConfig?.providers ?? []);

  return (
    <ThreadSettingsPickerScreen
      environmentId={selectedThread.environmentId}
      projectId={selectedThread.projectId}
      providerInstanceId={modelSelection.instanceId}
      {...(lockedProviderInstanceId ? { lockedProviderInstanceId } : {})}
      providerGroups={groupByProvider(modelOptions)}
      selectedModel={modelSelection}
      prompt={prompt}
      onPromptChange={(text) => setComposerDraftText(draftKey, text)}
      reportedModelSelection={reportedModelSelection}
      onSelectModel={(option) => updateModelSelection(withRememberedModelOptions(option.selection))}
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
export * from "./ThreadSettingsSheetParts3";
export * from "./ThreadSettingsSheetParts5";

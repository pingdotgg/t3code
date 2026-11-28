import { T, useGT, useLocale, useMessages } from "gt-react";
import { useLegendListRef } from "~/hooks/useLegendListRef";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import {
  formatProviderUpdateRequiredNotice,
  providerUpdateChannelLags,
} from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { groupModelsBySubProvider } from "@t3tools/client-runtime/providerSubProviders";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { useProviderWorkspaceSnapshotRefresh } from "./useProviderWorkspaceSnapshotRefresh";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  modelPickerSubProviderSectionKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { rankModelPickerSearch } from "@t3tools/client-runtime/model-search";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { registerModelPickerContent } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "~/hooks/useSettings";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { InlineButton } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { hasRuntimeModelCatalog } from "../../providerModels";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    hasRuntimeModelCatalog(input.entry.driverKind) &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

type ModelPickerListRow =
  | {
      kind: "model";
      key: string;
      instanceId: ProviderInstanceId;
      favorite: boolean;
      model: ModelPickerItem;
    }
  | {
      kind: "legacy";
      key: string;
      instanceId: ProviderInstanceId;
      displayName: string;
      isExpanded: boolean;
    }
  | {
      kind: "subProvider";
      key: string;
      instanceId: ProviderInstanceId;
      name: string;
      unavailableReason: string | undefined;
      count: number;
      isExpanded: boolean;
    };

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 44;
function ModelListSeparator() {
  return <div className="h-1" />;
}

function modelJumpLabelsByKey(
  modelKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
  terminalOpen: boolean,
): ReadonlyMap<string, string> {
  const shortcutLabelOptions = {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
  };
  const mapping = new Map<string, string>();
  for (const [index, modelKey] of modelKeys.entries()) {
    const command = modelPickerJumpCommandForIndex(index);
    const label = command && shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(modelKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
}

function ModelPickerProviderNotices({
  setupEntries,
  updateRequiredNotices,
  emptyLabel,
  onRequestClose,
  onOpenProviderSetup,
}: {
  setupEntries: ReadonlyArray<ProviderInstanceEntry>;
  emptyLabel: string;
  updateRequiredNotices: ReadonlyArray<{
    instanceId: ProviderInstanceId;
    notice: string;
    canUpdateInSettings: boolean;
  }>;
  onRequestClose: (() => void) | undefined;
  onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  return (
    <>
      {setupEntries.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
          {setupEntries.map((entry) => (
            <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
              <p className="line-clamp-3 text-muted-foreground">
                {getProviderStatusMessage(entry.snapshot, messages)}
              </p>
              <InlineButton
                className="mt-1"
                onClick={() => {
                  onRequestClose?.();
                  onOpenProviderSetup?.(entry.instanceId);
                }}
              >
                {setupEntries.length > 1
                  ? gt("Set up {provider}", { provider: entry.displayName })
                  : gt("Open provider setup")}
              </InlineButton>
            </div>
          ))}
        </div>
      ) : (
        <ComboboxEmpty className="empty:h-0">{emptyLabel}</ComboboxEmpty>
      )}
      {updateRequiredNotices.map(({ instanceId, notice, canUpdateInSettings }) => (
        <p
          key={instanceId}
          className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
        >
          {notice}
          {canUpdateInSettings ? (
            <>
              {" "}
              <InlineButton
                onClick={() => {
                  onRequestClose?.();
                  void navigate({ to: "/settings/providers" });
                }}
              >
                <T>Provider settings</T>
              </InlineButton>
            </>
          ) : null}
        </p>
      ))}
    </>
  );
}

function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
  initialScrollIndex,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  /** Opens the list with this row in view; read once, when the list mounts. */
  initialScrollIndex?: number | undefined;
  renderItem: (props: { item: string; index: number }) => ReactNode;
}) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const updateScrollFades = () => {
    const metrics = listRef.current?.getState();
    if (!metrics) return;
    setShowTopScrollFade(!metrics.isAtStart);
    setShowBottomScrollFade(!metrics.isAtEnd);
  };
  const scrollRef = useLegendListRef(listRef, updateScrollFades);

  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden pr-px",
        itemKeys.length > 0 ? "flex-1" : "h-0",
      )}
    >
      <ComboboxListVirtualized>
        <LegendList<string>
          ref={scrollRef}
          data={itemKeys}
          extraData={extraData}
          keyExtractor={(modelKey) => modelKey}
          {...(initialScrollIndex !== undefined && initialScrollIndex > 0
            ? { initialScrollIndex }
            : {})}
          renderItem={renderItem}
          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
          drawDistance={480}
          recycleItems
          contentContainerClassName="px-2"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={updateScrollFades}
          onScroll={updateScrollFades}
          onReady={updateScrollFades}
          className={cn(
            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
            getVirtualizedScrollFadeClassName({
              top: showTopScrollFade,
              bottom: showBottomScrollFade,
            }),
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a capture-phase window keydown listener for the picker's lifetime
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  /** Keeps the open provider tab's catalog fresh for this directory. */
  workspaceCwd?: string | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** The owning popup moves focus here when it opens (its `initialFocus`). */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Sits beside an effort column: fills the shared row, and stacks above it on narrow screens. */
  docked?: boolean;
  /** Right at the end of the search text moves into the popup's effort column. */
  onFocusEffort?: () => void;
  /** Closes the list column, inside the popup's fixed height. */
  listFooter?: ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const {
    searchInputRef,
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
    onRequestClose,
    onOpenProviderSetup,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const modelListRef = useRef<LegendListRef | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this picker's mount to global keydown handlers
  useLayoutEffect(() => registerModelPickerContent(), []);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const lastProviderJumpRef = useRef<ProviderInstanceId | null>(null);
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = props.selectedModels?.map((selection) => {
    const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
  });
  const selectedModelKeySet = new Set(
    selectedModelKeys ?? (activeModelKey ? [activeModelKey] : []),
  );
  const { scanning: workspaceModelsScanning } = useProviderWorkspaceSnapshotRefresh({
    environmentId: props.environmentId,
    gitCwd: props.workspaceCwd ?? null,
    instanceId: props.activeInstanceId,
  });
  const favoritesSet = new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        activeModel?.isLegacy &&
          !favoritesSet.has(providerModelKey(props.activeInstanceId, activeModelSlug))
          ? [props.activeInstanceId]
          : [],
      ),
  );
  // The thread's backend opens expanded, so its models show without a click.
  const [expandedSubProviderKeys, setExpandedSubProviderKeys] = useState(
    () =>
      new Set<string>(
        activeModel?.subProvider
          ? [modelPickerSubProviderSectionKey(props.activeInstanceId, activeModel.subProvider)]
          : [],
      ),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const toggleFavorite = useToggleEnvironmentModelFavorite(props.environmentId);

  const toggleLegacySection = (instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  };

  const toggleSubProviderSection = (key: string) => {
    setExpandedSubProviderKeys((expanded) => {
      const next = new Set(expanded);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const handleModelSelect = (
    modelSlug: string,
    instanceId: ProviderInstanceId,
    additive = false,
  ): string | null => {
    if (getModelDisabledReason?.(instanceId, modelSlug)) {
      return null;
    }
    const options = modelOptionsByInstance.get(instanceId);
    if (!options) {
      return null;
    }
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) {
      return null;
    }
    const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
    if (!resolvedModel) return null;
    if (additive && onToggleModel) {
      onToggleModel(instanceId, resolvedModel);
    } else {
      onInstanceModelChange(instanceId, resolvedModel);
    }
    return resolvedModel;
  };

  const modelJumpShortcutContext = {
    terminalFocus: false,
    terminalOpen: props.terminalOpen,
    modelPickerOpen: true,
  } as const;
  const lockedProvider = props.lockedProvider;
  const lockedContinuationGroupKey = props.lockedContinuationGroupKey;
  const canOpenProviderSetup = onOpenProviderSetup !== undefined;

  const entryByInstanceId = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  const matchesLockedProvider = (
    entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  ): boolean => {
    if (lockedProvider === null) return true;
    if (entry.driverKind !== lockedProvider) return false;
    if (!lockedContinuationGroupKey) return true;
    return entry.continuationGroupKey === lockedContinuationGroupKey;
  };

  const flatModels = (() => {
    const out: ModelPickerItem[] = [];
    const seenKeys = new Set<string>();
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        continue;
      }
      for (const model of models) {
        const key = modelPickerModelKey(instanceId, model.slug);
        if (
          seenKeys.has(key) ||
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        seenKeys.add(key);
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.acpRegistryAgentId ? { acpRegistryAgentId: entry.acpRegistryAgentId } : {}),
          ...(entry.acpRegistryIconUrl ? { acpRegistryIconUrl: entry.acpRegistryIconUrl } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  })();

  const subProvidersByInstance = new Map(
    instanceEntries.flatMap((entry) =>
      entry.snapshot.subProviders?.length
        ? [[entry.instanceId, entry.snapshot.subProviders] as const]
        : [],
    ),
  );
  const isLocked = lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  const browseEntries = instanceEntries.filter(
    (entry) =>
      (isProviderInstancePickerVisible(entry) || entry.instanceId === props.activeInstanceId) &&
      matchesLockedProvider(entry),
  );
  const browseInstanceIds = new Set(browseEntries.map((entry) => entry.instanceId));
  const instanceOrder = browseEntries.map((entry) => entry.instanceId);
  const isFavoriteModel = (model: ModelPickerItem) =>
    favoritesSet.has(providerModelKey(model.instanceId, model.slug));

  // One merged list: favorites first, then each provider's models in provider order. A model is
  // listed once, so every row key is a unique combobox item.
  const listRows = ((): ModelPickerListRow[] => {
    const modelRow = (model: ModelPickerItem, favorite: boolean): ModelPickerListRow => ({
      kind: "model",
      key: modelPickerModelKey(model.instanceId, model.slug),
      instanceId: model.instanceId,
      favorite,
      model,
    });
    if (isSearching) {
      const candidates = isLocked ? flatModels.filter((m) => matchesLockedProvider(m)) : flatModels;
      return rankModelPickerSearch(candidates, searchQuery, (model) => ({
        name: model.name,
        slug: model.slug,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: model.instanceDisplayName,
        isFavorite: isFavoriteModel(model),
      })).map((model) => modelRow(model, isFavoriteModel(model)));
    }
    const browsable = flatModels.filter((model) => browseInstanceIds.has(model.instanceId));
    const rows: ModelPickerListRow[] = sortProviderModelItems(browsable.filter(isFavoriteModel), {
      instanceOrder,
    }).map((model) => modelRow(model, true));
    for (const entry of browseEntries) {
      const models = browsable.filter(
        (model) => model.instanceId === entry.instanceId && !isFavoriteModel(model),
      );
      // A provider whose models run on several backends, such as fx, lists each backend as a
      // collapsible heading.
      const subProviders = subProvidersByInstance.get(entry.instanceId);
      if (subProviders) {
        const { ungrouped, groups } = groupModelsBySubProvider(
          models,
          subProviders,
          (model) => model.subProvider,
        );
        rows.push(...ungrouped.map((model) => modelRow(model, false)));
        for (const { subProvider, models: groupModels } of groups) {
          const key = modelPickerSubProviderSectionKey(entry.instanceId, subProvider.name);
          const isExpanded = expandedSubProviderKeys.has(key);
          rows.push({
            kind: "subProvider",
            key,
            instanceId: entry.instanceId,
            name: subProvider.name,
            unavailableReason: subProvider.unavailableReason,
            count: groupModels.length,
            isExpanded,
          });
          if (isExpanded) rows.push(...groupModels.map((model) => modelRow(model, false)));
        }
        continue;
      }
      rows.push(
        ...models.filter((model) => !model.isLegacy).map((model) => modelRow(model, false)),
      );
      const legacyModels = models.filter((model) => model.isLegacy);
      if (legacyModels.length === 0) continue;
      const isExpanded = expandedLegacyInstances.has(entry.instanceId);
      if (isExpanded) rows.push(...legacyModels.map((model) => modelRow(model, false)));
      // The toggle trails the provider's models, so expanding it reveals older ones above it.
      rows.push({
        kind: "legacy",
        key: modelPickerLegacySectionKey(entry.instanceId),
        instanceId: entry.instanceId,
        displayName: entry.displayName,
        isExpanded,
      });
    }
    return rows;
  })();
  const filteredItemKeys = listRows.map((row) => row.key);
  const visibleModels = listRows.flatMap((row) => (row.kind === "model" ? [row.model] : []));
  const filteredModelByKey: ReadonlyMap<string, ModelPickerItem> = new Map(
    visibleModels.map(
      (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
    ),
  );
  const legacyRowByKey = new Map(
    listRows.flatMap((row) => (row.kind === "legacy" ? [[row.key, row] as const] : [])),
  );
  const subProviderSectionByKey = new Map(
    listRows.flatMap((row) => (row.kind === "subProvider" ? [[row.key, row] as const] : [])),
  );
  const activeRowIndex = activeModelKey ? filteredItemKeys.indexOf(activeModelKey) : -1;
  const providerJumpTargets = isSearching
    ? []
    : browseEntries.flatMap((entry) => {
        const index = listRows.findIndex(
          (row) => row.instanceId === entry.instanceId && !(row.kind === "model" && row.favorite),
        );
        return index < 0
          ? []
          : [{ instanceId: entry.instanceId, displayName: entry.displayName, index }];
      });

  const providerSetupEntries =
    !isSearching && canOpenProviderSetup
      ? browseEntries.filter(
          (entry) =>
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            (entry.instanceId === props.activeInstanceId || visibleModels.length === 0),
        )
      : [];

  const updateRequiredNotices = instanceEntries.flatMap((entry) => {
    const shown = isSearching
      ? matchesLockedProvider(entry)
      : entry.instanceId === props.activeInstanceId;
    const notice = shown
      ? formatProviderUpdateRequiredNotice(entry.snapshot, searchQuery, messages, locale)
      : null;
    return notice
      ? [
          {
            instanceId: entry.instanceId,
            notice,
            canUpdateInSettings: !providerUpdateChannelLags(entry.snapshot, searchQuery),
          },
        ]
      : [];
  });

  const modelJumpModelKeys = visibleModels
    .filter((model) => !getModelDisabledReason?.(model.instanceId, model.slug))
    .slice(0, MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.length)
    .map((model) => modelPickerModelKey(model.instanceId, model.slug));
  const allItemKeys = ((): string[] => [
    ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    ...new Set(
      flatModels
        .filter((model) => model.isLegacy)
        .map((model) => modelPickerLegacySectionKey(model.instanceId)),
    ),
    ...[...subProvidersByInstance].flatMap(([instanceId, subProviders]) =>
      subProviders.map((subProvider) =>
        modelPickerSubProviderSectionKey(instanceId, subProvider.name),
      ),
    ),
  ])();
  const modelJumpLabelByKey = modelJumpLabelsByKey(
    modelJumpModelKeys,
    keybindings,
    props.terminalOpen,
  );
  const badgedInstanceIds = new Set(
    instanceEntries
      .filter((entry) => shouldShowInstanceBadge(entry, instanceEntries))
      .map((entry) => entry.instanceId),
  );
  const modelListExtraData = {
    badgedInstanceIds,
    favoritesSet,
    modelJumpLabelByKey,
    activeModelKey,
    selectedModelKeySet,
  };

  const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      isCommandPaletteOpen()
    ) {
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    });
    if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
      if (providerJumpTargets.length < 2) return;
      event.preventDefault();
      event.stopPropagation();
      // There are no provider tabs, so these keys scroll to the neighboring provider's models.
      const highlightedRow = highlightedModelKeyRef.current
        ? listRows.find((row) => row.key === highlightedModelKeyRef.current)
        : undefined;
      const currentId =
        lastProviderJumpRef.current ?? highlightedRow?.instanceId ?? props.activeInstanceId;
      const at = providerJumpTargets.findIndex((target) => target.instanceId === currentId);
      const direction = command === "modelPicker.nextProvider" ? 1 : -1;
      const target =
        providerJumpTargets[
          at < 0
            ? direction === 1
              ? 0
              : providerJumpTargets.length - 1
            : (at + direction + providerJumpTargets.length) % providerJumpTargets.length
        ]!;
      lastProviderJumpRef.current = target.instanceId;
      void modelListRef.current?.scrollIndexIntoView?.({ index: target.index, animated: false });
      announce(target.displayName, "model-picker");
      return;
    }
    const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
    if (jumpIndex === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const targetModelKey = modelJumpModelKeys[jumpIndex];
    if (!targetModelKey) {
      return;
    }
    const model = parseModelPickerModelKey(targetModelKey);
    if (!model) {
      return;
    }
    const selectedSlug = handleModelSelect(model.slug, model.instanceId);
    if (selectedSlug === null) return;
    const name = flatModels.find(
      (item) => item.slug === selectedSlug && item.instanceId === model.instanceId,
    )?.name;
    announce(gt("Model: {name}", { name: name ?? selectedSlug }), "model-picker");
  };

  return (
    <>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        className={cn(
          "relative flex flex-col overflow-hidden",
          props.docked ? "h-full w-full" : "h-80 w-80 max-w-[calc(100vw-1rem)]",
        )}
        data-model-picker-content="true"
      >
        <Combobox<string, boolean>
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedModelKeySet] : activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            lastProviderJumpRef.current = null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const modelKey = Array.isArray(value)
              ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                [...selectedModelKeySet].find((key) => !value.includes(key)))
              : value;
            if (typeof modelKey !== "string") {
              return;
            }
            const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
            if (legacyInstanceId) {
              toggleLegacySection(legacyInstanceId);
              return;
            }
            if (subProviderSectionByKey.has(modelKey)) {
              toggleSubProviderSection(modelKey);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(
                model.slug,
                model.instanceId,
                "shiftKey" in details.event && details.event.shiftKey === true,
              );
            }
          }}
        >
          <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden")}>
            <div className="shrink-0 bg-linear-to-b from-primary/10 to-transparent px-3 pt-3 pb-2">
              <div className="mb-2.5 flex items-center justify-between px-0.5">
                <h2 className="font-extrabold text-base uppercase leading-none tracking-wider">
                  {gt("Models")}
                </h2>
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  {visibleModels.length}
                </span>
              </div>
              <ComboboxSearchInput
                variant="field"
                ref={searchInputRef}
                placeholder={gt("Search models...")}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) {
                    (
                      e as typeof e & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    e.stopPropagation();
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onRequestClose?.();
                    return;
                  }
                  if (
                    props.onFocusEffort &&
                    e.key === "ArrowRight" &&
                    !e.altKey &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.shiftKey &&
                    e.currentTarget.selectionStart === searchQuery.length
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    // The column shows the selected model's effort, so a highlighted model is picked
                    // first; the owning popup then moves focus to that model's levels.
                    const highlighted = highlightedModelKeyRef.current
                      ? parseModelPickerModelKey(highlightedModelKeyRef.current)
                      : null;
                    const pickedNew =
                      highlighted !== null &&
                      highlightedModelKeyRef.current !== activeModelKey &&
                      handleModelSelect(highlighted.slug, highlighted.instanceId) !== null;
                    if (!pickedNew) props.onFocusEffort();
                    return;
                  }
                  if (e.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      e as typeof e & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    e.preventDefault();
                    e.stopPropagation();
                    const legacyInstanceId = parseModelPickerLegacySectionKey(
                      highlightedModelKeyRef.current,
                    );
                    if (legacyInstanceId) {
                      toggleLegacySection(legacyInstanceId);
                      return;
                    }
                    if (subProviderSectionByKey.has(highlightedModelKeyRef.current)) {
                      toggleSubProviderSection(highlightedModelKeyRef.current);
                      return;
                    }
                    const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                    if (model) {
                      handleModelSelect(model.slug, model.instanceId, e.shiftKey);
                    }
                    return;
                  }
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              />
            </div>

            <ModelPickerList
              listRef={modelListRef}
              itemKeys={filteredItemKeys}
              // Only a model past the first screen needs scrolling to; one row above it stays for context.
              initialScrollIndex={activeRowIndex > 4 ? activeRowIndex - 1 : undefined}
              extraData={modelListExtraData}
              renderItem={({ item: modelKey, index }) => {
                const legacyRow = legacyRowByKey.get(modelKey);
                if (legacyRow) {
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={modelKey}
                      aria-expanded={legacyRow.isExpanded}
                      variant="card"
                      className="group w-full cursor-pointer"
                    >
                      <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground group-data-highlighted:text-foreground">
                        {legacyRow.isExpanded
                          ? gt("Show fewer {provider} models", {
                              provider: legacyRow.displayName,
                              $context: "collapses the list of older models",
                            })
                          : gt("Show older {provider} models", {
                              provider: legacyRow.displayName,
                              $context: "expands the list of older models",
                            })}
                      </span>
                    </ComboboxItem>
                  );
                }
                const subProviderSection = subProviderSectionByKey.get(modelKey);
                if (subProviderSection) {
                  const unavailable = subProviderSection.unavailableReason !== undefined;
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={modelKey}
                      disabled={unavailable}
                      aria-expanded={unavailable ? undefined : subProviderSection.isExpanded}
                      variant="card"
                      className="group w-full cursor-pointer"
                    >
                      <div className="min-w-0 flex-1 text-left">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="min-w-0 truncate text-sm font-normal leading-snug">
                            {subProviderSection.name}
                          </div>
                          {unavailable ? (
                            <Badge variant="outline" size="sm">
                              {gt("Unavailable", { $context: "backend cannot be used right now" })}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground">
                          {subProviderSection.unavailableReason ??
                            gt("{count, plural, one {{count} model} other {{count} models}}", {
                              count: subProviderSection.count,
                            })}
                        </div>
                      </div>
                      {unavailable ? null : (
                        <ChevronRightIcon
                          className={cn(
                            "size-4 shrink-0 transition-transform",
                            subProviderSection.isExpanded && "rotate-90",
                          )}
                        />
                      )}
                    </ComboboxItem>
                  );
                }
                const model = filteredModelByKey.get(modelKey);
                if (!model) {
                  return null;
                }
                const disabledReason =
                  getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                return (
                  <ModelListRow
                    key={modelKey}
                    index={index}
                    slug={model.slug}
                    name={model.name}
                    subProvider={model.subProvider}
                    instanceId={model.instanceId}
                    driverKind={model.driverKind}
                    providerDisplayName={model.instanceDisplayName}
                    providerAccentColor={model.instanceAccentColor}
                    acpRegistryAgentId={model.acpRegistryAgentId}
                    acpRegistryIconUrl={model.acpRegistryIconUrl}
                    isFavorite={favoritesSet.has(providerModelKey(model.instanceId, model.slug))}
                    isSelected={
                      selectedModelKeys !== undefined
                        ? selectedModelKeySet.has(modelKey)
                        : modelKey === activeModelKey
                    }
                    showInstanceBadge={badgedInstanceIds.has(model.instanceId)}
                    showNewBadge={model.badge === "new"}
                    unavailable={model.isUnavailable === true}
                    jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                    disabledReason={disabledReason}
                    onToggleFavorite={toggleFavorite}
                  />
                );
              }}
            />
            <ModelPickerProviderNotices
              setupEntries={providerSetupEntries}
              updateRequiredNotices={updateRequiredNotices}
              emptyLabel={
                workspaceModelsScanning ? gt("Searching project models...") : gt("No models found")
              }
              onRequestClose={onRequestClose}
              onOpenProviderSetup={onOpenProviderSetup}
            />
            {isLocked &&
            instanceEntries.some(
              (entry) => isProviderInstancePickerVisible(entry) && !matchesLockedProvider(entry),
            ) ? (
              <p className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground">
                {gt("This thread keeps its provider. Start a new thread to switch.")}
              </p>
            ) : null}
            {props.listFooter}
          </div>
        </Combobox>
      </div>
    </>
  );
});

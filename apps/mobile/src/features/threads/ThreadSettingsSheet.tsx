import type {
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { applyProviderOptionSelection, providerOptionValueLabels } from "../../lib/providerOptions";
import { useThemeColor } from "../../lib/useThemeColor";
import { RUNTIME_MODE_CHOICES, selectableChoices } from "./thread-settings-menu";
import {
  pendingModelAfterPress,
  usesInlineSelectChoices,
  visibleSheetOptionDescriptors,
} from "./thread-settings-sheet-state";
import type { ThreadSettingsSheetCloseReason } from "./use-thread-settings-sheet-presentation";

/**
 * The everyday harnesses stay expanded; every other provider (OpenRouter
 * catalogs and friends) folds behind its header so a 300-model catalog can't
 * bury the list.
 */
const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

const SETTINGS_LAYOUT_ANIMATION = {
  duration: 180,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

/**
 * Compact "Fable 5 · Max · Auto" style summary for the composer trigger pill,
 * covering model, provider options, runtime mode, and plan mode in one label.
 */
export function threadSettingsSummaryLabel(input: {
  readonly modelLabel: string;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): string {
  const runtime = RUNTIME_MODE_CHOICES.find((choice) => choice.mode === input.runtimeMode);
  return [
    input.modelLabel,
    ...providerOptionValueLabels(input.optionDescriptors),
    ...(runtime ? [runtime.shortLabel] : []),
    ...(input.interactionMode === "plan" ? ["Plan"] : []),
  ].join(" · ");
}

function ModelRow(props: {
  readonly option: ModelOption;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const primaryFg = useThemeColor("--color-primary-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      // Selected rows get the same primary treatment as the submenu rows.
      // Subtle backgrounds (bg-subtle-strong) get overridden by the OS
      // selection chrome on iOS 26, so use the explicit high-contrast style
      // everywhere instead.
      className={cn(
        "mx-2.5 flex-row items-center gap-2 rounded-xl px-3 py-3.5 active:opacity-70",
        props.selected ? "bg-primary" : "bg-transparent",
      )}
    >
      <Text
        className={cn(
          "shrink text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {props.option.label}
      </Text>
      {props.option.isDefault ? (
        <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
          <Text className="text-3xs font-t3-bold text-foreground-muted">Default</Text>
        </View>
      ) : null}
      {props.option.isLegacy ? (
        <View className="rounded-md bg-subtle px-1.5 py-0.5">
          <Text className="text-3xs font-t3-bold text-foreground-muted">Legacy</Text>
        </View>
      ) : null}
      <View className="flex-1" />
      {props.selected ? (
        <SymbolView name="checkmark" size={14} tintColor={primaryFg} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

/**
 * Provider section header with the harness logo. Secondary providers render
 * as a tappable fold (count + chevron while collapsed); primary providers
 * and the group holding the current selection are static headers.
 */
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole={props.collapsible ? "button" : "header"}
      accessibilityState={props.collapsible ? { expanded: !props.collapsed } : undefined}
      accessibilityLabel={
        props.collapsible ? `${props.label}, ${props.modelCount} models` : props.label
      }
      disabled={!props.collapsible}
      onPress={props.onToggle}
      className={cn(
        "mx-2.5 flex-row items-center gap-2 rounded-xl px-3",
        props.collapsible ? "py-3.5 active:opacity-70" : "pb-2 pt-4",
      )}
    >
      <ProviderIcon provider={props.driver} size={15} />
      <Text className="text-2xs font-t3-bold uppercase tracking-widest text-foreground-muted">
        {props.label}
      </Text>
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
            size={11}
            tintColor={iconSubtle}
            type="monochrome"
          />
        </>
      ) : null}
    </Pressable>
  );
}

/** Compact row that opens a single-choice submenu panel. */
function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="flex-row items-center gap-2 px-5 py-2.5 active:opacity-70"
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView name="chevron.right" size={12} tintColor={iconSubtle} type="monochrome" />
    </Pressable>
  );
}

/** Inline mutually-exclusive choices for short catalogs (reasoning, runtime). */
function ChoiceChipRow(props: {
  readonly label: string;
  readonly choices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }>;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  const equalWidth = props.choices.length > 1 && props.choices.length <= 4;
  return (
    <View className="gap-2 px-5 py-2.5">
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className={cn("flex-row gap-1.5", equalWidth ? undefined : "flex-wrap")}>
        {props.choices.map((choice) => {
          const selected = choice.id === props.selectedId;
          return (
            <Pressable
              key={choice.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={choice.accessibilityLabel ?? `${props.label}, ${choice.label}`}
              onPress={() => {
                if (choice.id === props.selectedId) {
                  return;
                }
                void Haptics.selectionAsync();
                props.onSelect(choice.id);
              }}
              className={cn(
                "rounded-full px-3 py-1.5 active:opacity-70",
                selected ? "bg-primary" : "bg-subtle",
                equalWidth && "min-w-0 flex-1 items-center",
              )}
            >
              <Text
                className={cn(
                  "text-xs font-t3-medium",
                  selected ? "text-primary-foreground" : "text-foreground",
                  equalWidth && "text-center",
                )}
                numberOfLines={1}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Single option inside a submenu panel. */
function ChoiceRow(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const primaryFg = useThemeColor("--color-primary-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={cn(
        "mx-2.5 flex-row items-center rounded-xl px-3 py-3.5 active:opacity-70",
        props.selected ? "bg-primary" : "bg-transparent",
      )}
    >
      <Text
        className={cn(
          "shrink text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
      <View className="flex-1" />
      {props.selected ? (
        <SymbolView name="checkmark" size={14} tintColor={primaryFg} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const activeTrack = String(useThemeColor("--color-switch-active"));
  const track = String(useThemeColor("--color-secondary-border"));
  return (
    <View className="flex-row items-center justify-between px-5 py-2.5">
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <Switch
        ios_backgroundColor={track}
        onValueChange={props.onValueChange}
        trackColor={{ false: track, true: activeTrack }}
        value={props.value}
      />
    </View>
  );
}

type SubmenuPage = { readonly kind: "descriptor"; readonly id: string };

/**
 * Unified thread settings: the sheet is the provider-grouped model list
 * (primary harnesses expanded, other providers folded, legacy behind the
 * top-right pill) with a Save button. Settings below the list are only the
 * options the displayed model actually supports — short catalogs (reasoning,
 * context, runtime) render as chips; longer ones still open a stacked
 * submenu. Model changes stage until Save — while staged, the settings
 * edit the staged model's options and Save applies everything together.
 *
 * Callers control which harnesses are offered via providerGroups: an
 * existing thread must pass only its own provider's group, since a session
 * can't switch harness mid-thread.
 *
 * Rendered through an RN Modal (not the root OverlayPortal) so it also
 * presents above natively-presented form sheets like the new-task draft.
 * Callers must dismiss the keyboard when opening — the iOS keyboard window
 * would otherwise cover the lower half of the sheet.
 */
export function ThreadSettingsSheet(props: {
  readonly visible: boolean;
  /**
   * "save" = the Save/Done button (the user is finished configuring);
   * "dismiss" = backdrop, grabber, or system back. Hosts only restore the
   * keyboard for "save" so a stray tap outside a control never pops it.
   */
  readonly onClose: (reason: ThreadSettingsSheetCloseReason) => void;
  readonly onDismissed: () => void;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [submenu, setSubmenu] = useState<SubmenuPage | null>(null);
  const wasPresentedRef = useRef(false);
  const notifyDismissed = useCallback(() => {
    if (!wasPresentedRef.current) {
      return;
    }
    wasPresentedRef.current = false;
    props.onDismissed();
  }, [props.onDismissed]);

  // Every open starts fresh: no staged model, no submenu, legacy hidden,
  // secondary providers folded. The sheet stays mounted between opens, so
  // state would otherwise stick around.
  useEffect(() => {
    if (props.visible) {
      wasPresentedRef.current = true;
      setShowLegacyToggle(false);
      setExpandedProviders(new Set());
      setPendingModel(null);
      setSubmenu(null);
    } else if (Platform.OS === "android" && wasPresentedRef.current) {
      // React Native only emits Modal.onDismiss on iOS. Android uses no exit
      // animation below, so the post-commit effect is its dismissal boundary.
      notifyDismissed();
    }
  }, [notifyDismissed, props.visible]);

  const isApplied = (option: ModelOption) =>
    option.selection.instanceId === props.selectedModel?.instanceId &&
    option.selection.model === props.selectedModel.model;
  // The list highlights the staged pick; Save turns it into the applied one.
  const isDisplayed = (option: ModelOption) =>
    pendingModel ? option.key === pendingModel.key : isApplied(option);

  // While a model is staged, the settings rows describe and edit the staged
  // model's options (kept on its pending selection); Save applies model and
  // options together. Otherwise they edit the applied selection directly.
  const displayedDescriptors = pendingModel
    ? pendingModel.capabilities
      ? getProviderOptionDescriptors({
          caps: pendingModel.capabilities,
          selections: pendingModel.selection.options,
        })
      : []
    : props.optionDescriptors;

  const hasLegacyModels = props.providerGroups.some((group) =>
    group.models.some((model) => model.isLegacy),
  );
  // Legacy stays hidden unless the pill is toggled this open; a highlighted
  // legacy model is exempted from the filter instead of forcing the whole
  // legacy list visible.
  const showLegacy = showLegacyToggle;
  const visibleDescriptors = visibleSheetOptionDescriptors(displayedDescriptors);

  const handleSave = () => {
    if (pendingModel) {
      void Haptics.selectionAsync();
      props.onSelectModel(pendingModel);
    }
    props.onClose("save");
  };

  const handleOptionChange = (id: string, value: string | boolean) => {
    const next = applyProviderOptionSelection(displayedDescriptors, { id, value });
    if (!next) {
      return;
    }
    if (pendingModel) {
      setPendingModel({
        ...pendingModel,
        selection: { ...pendingModel.selection, options: next },
      });
    } else {
      props.onUpdateOptionSelections(next);
    }
  };

  const toggleProvider = (providerKey: string) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  };

  const activeDescriptor = displayedDescriptors.find(
    (descriptor) =>
      submenu !== null && descriptor.type === "select" && descriptor.id === submenu.id,
  );

  const submenuContent =
    activeDescriptor?.type === "select"
      ? {
          title: activeDescriptor.label,
          rows: selectableChoices(activeDescriptor).map((choice) => ({
            id: choice.id,
            label: choice.label,
            selected: choice.id === getProviderOptionCurrentValue(activeDescriptor),
            onPress: () => {
              void Haptics.selectionAsync();
              handleOptionChange(activeDescriptor.id, choice.id);
              setSubmenu(null);
            },
          })),
        }
      : null;

  return (
    <Modal
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType={Platform.OS === "ios" ? "fade" : "none"}
      visible={props.visible}
      onDismiss={notifyDismissed}
      onRequestClose={submenuContent ? () => setSubmenu(null) : () => props.onClose("dismiss")}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Close thread settings"
          className="absolute inset-0 bg-backdrop"
          onPress={() => props.onClose("dismiss")}
        />
        <View
          className="overflow-hidden rounded-t-[24px] border border-b-0 border-border bg-sheet"
          style={{ maxHeight: windowHeight * 0.85 }}
        >
          {/* The grabber doubles as the accessible close control: the dim
              backdrop above a tall sheet is a sliver, and VoiceOver can't
              reach it at all. */}
          <Pressable
            accessibilityLabel="Close thread settings"
            accessibilityRole="button"
            onPress={() => props.onClose("dismiss")}
            className="items-center pb-1 pt-2.5"
          >
            <View className="h-1 w-9 rounded-full bg-subtle-strong" />
          </Pressable>
          {hasLegacyModels ? (
            <View className="flex-row justify-end px-4 pb-1.5">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: showLegacy }}
                hitSlop={8}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setShowLegacyToggle(!showLegacy);
                }}
                className="rounded-full border border-border bg-subtle px-3 py-1.5 active:opacity-70"
              >
                <Text className="text-2xs font-t3-medium text-foreground-muted">
                  {showLegacy ? "Hide legacy models" : "Show legacy models"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {/* Only the model list scrolls. Provider catalogs can run to
              hundreds of models (OpenRouter), so the rows below stay pinned
              and reachable instead of living at the end of that scroll. */}
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingBottom: 8 }}
            showsVerticalScrollIndicator={false}
          >
            {props.providerGroups.map((group) => {
              const driver = group.models[0]?.providerDriver;
              const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
              const visibleModels = showLegacy
                ? group.models
                : group.models.filter((model) => !model.isLegacy || isDisplayed(model));
              if (visibleModels.length === 0) {
                return null;
              }
              const containsSelection = group.models.some(isDisplayed);
              const collapsible = !isPrimary && !containsSelection;
              const collapsed = collapsible && !expandedProviders.has(group.providerKey);
              return (
                <View key={group.providerKey}>
                  <ProviderHeader
                    driver={driver}
                    label={group.providerLabel}
                    collapsible={collapsible}
                    collapsed={collapsed}
                    modelCount={visibleModels.length}
                    onToggle={() => toggleProvider(group.providerKey)}
                  />
                  {collapsed
                    ? null
                    : visibleModels.map((option) => (
                        <ModelRow
                          key={option.key}
                          option={option}
                          selected={isDisplayed(option)}
                          onPress={() => {
                            void Haptics.selectionAsync();
                            LayoutAnimation.configureNext(SETTINGS_LAYOUT_ANIMATION);
                            // Re-tapping the applied model cancels staging.
                            setPendingModel((current) =>
                              pendingModelAfterPress({
                                current,
                                pressed: option,
                                pressedIsApplied: isApplied(option),
                              }),
                            );
                          }}
                        />
                      ))}
                </View>
              );
            })}
          </ScrollView>

          <View className="mx-5 h-px bg-border" />

          <View className="pt-1" style={{ paddingBottom: insets.bottom + 12 }}>
            {visibleDescriptors.map((descriptor) => {
              if (descriptor.type === "select") {
                if (usesInlineSelectChoices(descriptor)) {
                  const currentValue = getProviderOptionCurrentValue(descriptor);
                  return (
                    <ChoiceChipRow
                      key={descriptor.id}
                      label={descriptor.label}
                      selectedId={typeof currentValue === "string" ? currentValue : undefined}
                      choices={selectableChoices(descriptor).map((choice) => ({
                        id: choice.id,
                        label: choice.label,
                      }))}
                      onSelect={(id) => handleOptionChange(descriptor.id, id)}
                    />
                  );
                }
                return (
                  <DisclosureRow
                    key={descriptor.id}
                    label={descriptor.label}
                    value={getProviderOptionCurrentLabel(descriptor)}
                    onPress={() => setSubmenu({ kind: "descriptor", id: descriptor.id })}
                  />
                );
              }
              return (
                <SwitchRow
                  key={descriptor.id}
                  label={descriptor.label}
                  value={descriptor.currentValue ?? false}
                  onValueChange={(value) => handleOptionChange(descriptor.id, value)}
                />
              );
            })}
            <ChoiceChipRow
              label="Runtime"
              selectedId={props.runtimeMode}
              choices={RUNTIME_MODE_CHOICES.map((choice) => ({
                id: choice.mode,
                label: choice.shortLabel,
                accessibilityLabel: `Runtime, ${choice.label}`,
              }))}
              onSelect={(id) => {
                const choice = RUNTIME_MODE_CHOICES.find((candidate) => candidate.mode === id);
                if (choice) {
                  props.onUpdateRuntimeMode(choice.mode);
                }
              }}
            />
            <Pressable
              accessibilityRole="button"
              onPress={handleSave}
              className="mx-4 mt-2 h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
            >
              <Text className="text-sm font-t3-bold text-primary-foreground">
                {pendingModel ? "Save" : "Done"}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Submenus stack over the sheet instead of replacing its content,
            so the main sheet keeps its size while drilling in and out. */}
        {submenuContent ? (
          <View className="absolute inset-0 justify-end">
            <Pressable
              accessibilityLabel={`Close ${submenuContent.title}`}
              className="absolute inset-0 bg-backdrop"
              onPress={() => setSubmenu(null)}
            />
            <View className="overflow-hidden rounded-t-[24px] border border-b-0 border-border bg-sheet">
              <Pressable
                accessibilityLabel={`Close ${submenuContent.title}`}
                accessibilityRole="button"
                onPress={() => setSubmenu(null)}
                className="items-center pb-1 pt-2.5"
              >
                <View className="h-1 w-9 rounded-full bg-subtle-strong" />
              </Pressable>
              <Text className="px-5 pb-1.5 text-2xs font-t3-bold uppercase tracking-widest text-foreground-muted">
                {submenuContent.title}
              </Text>
              <ScrollView
                style={{ maxHeight: windowHeight * 0.5 }}
                contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                {submenuContent.rows.map((row) => (
                  <ChoiceRow
                    key={row.id}
                    label={row.label}
                    selected={row.selected}
                    onPress={row.onPress}
                  />
                ))}
              </ScrollView>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

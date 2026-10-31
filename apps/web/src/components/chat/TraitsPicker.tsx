import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getTraitSelectChange,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
  isReasoningControl,
  isReasoningSelect,
} from "@t3tools/client-runtime/model-traits";
import {
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuState } from "./useComposerMenuState";
import { DESCRIPTOR_PRESETS_BY_KIND } from "../settings/customModelEditor.logic";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * All the picker reads from the prompt while rendering. Passing this instead of
 * the prompt keeps the picker from re-rendering on every keystroke.
 */
export type PromptUltrathink = "none" | "prefix" | "body";

export function readPromptUltrathink(prompt: string): PromptUltrathink {
  if (!isClaudeUltrathinkPrompt(prompt)) return "none";
  return isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, "")) ? "body" : "prefix";
}

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Reasoning",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

/**
 * Read-only descriptors for saved values whose model metadata is unavailable
 * (provider not installed, catalog not loaded, or model missing from it).
 * A value from the driver's known preset keeps that preset's labels and
 * choices; anything else shows verbatim.
 */
function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
  provider?: ProviderDriverKind,
): ReadonlyArray<ProviderOptionDescriptor> {
  const presets = provider ? DESCRIPTOR_PRESETS_BY_KIND[provider] : undefined;
  return (selections ?? []).map((selection) => {
    if (typeof selection.value === "boolean") {
      return {
        id: selection.id,
        label: savedOptionLabel(selection.id),
        type: "boolean" as const,
        currentValue: selection.value,
      };
    }
    const value = selection.value;
    const choices = presets?.find((preset) => preset.id === selection.id)?.choices;
    return {
      id: selection.id,
      label: savedOptionLabel(selection.id),
      type: "select" as const,
      options:
        choices?.some((choice) => choice.id === value) === true
          ? choices.map(({ id, label }) => ({ id, label }))
          : [{ id: value, label: value }],
      currentValue: value,
    };
  });
}

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function DefaultBadge() {
  return (
    <Badge variant="outline" size="sm" className="min-w-0">
      Default
    </Badge>
  );
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  promptUltrathink: PromptUltrathink,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
  planModeEnabled: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  const modelIsUnavailable =
    provider === "opencode"
      ? !models.some((candidate) => candidate.slug === normalizeModelSlug(model, provider))
      : resolveSelectableModel(provider, model, models) === null;
  const descriptors = modelIsUnavailable
    ? buildUnavailableModelOptionDescriptors(
        planModeEnabled
          ? modelOptions
          : modelOptions?.filter((option) => option.id !== "agent" || option.value !== "plan"),
        provider,
      )
    : getProviderOptionDescriptors({
        caps,
        selections: modelOptions,
      });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptUltrathink !== "none";
  const ultrathinkInBodyText = ultrathinkPromptControlled && promptUltrathink === "body";
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
    modelIsUnavailable,
  };
}

export function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.promptUltrathink ?? "none",
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
    input.planModeEnabled,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls:
      showEffort ||
      showThinking ||
      showFastMode ||
      showContextWindow ||
      showAgent ||
      (selected.modelIsUnavailable && selected.descriptors.length > 0),
  };
}

/**
 * `modelOptions` must already carry the composer's implicit defaults (see
 * `withImplicitFastModeDefault`) so the persisted selection matches what the
 * picker would write.
 */
export function getReasoningTraitStep(input: {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderOptions | undefined;
  reportedModelSelection: ModelSelection | null | undefined;
  prompt: string;
  planModeEnabled: boolean;
  direction: 1 | -1;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    readPromptUltrathink(input.prompt),
    input.modelOptions,
    true,
    input.planModeEnabled,
  );
  if (selected.modelIsUnavailable || selected.ultrathinkInBodyText) return null;
  const descriptor = selected.selectDescriptors.find(isReasoningSelect);
  const choices = descriptor ? selectableProviderOptionChoices(descriptor) : [];
  if (!descriptor || choices.length < 2) return null;
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  const current =
    isPrimary && selected.ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(
          descriptor,
          { instanceId: input.instanceId, model: input.model, options: input.modelOptions ?? [] },
          input.reportedModelSelection,
        );
  // Walk the full catalog order so a typed Ultrathink keeps its place, then land on a pickable level.
  const ordered = input.direction > 0 ? descriptor.options : descriptor.options.toReversed();
  const position =
    [current, getDescriptorStringValue(descriptor)]
      .map((value) => ordered.findIndex((option) => option.id === value))
      .find((index) => index >= 0) ?? -1;
  const next = [...ordered.slice(position + 1), ...ordered.slice(0, Math.max(position, 0))].find(
    (option) => choices.includes(option),
  );
  const change = next && getTraitSelectChange(selected, descriptor, input.prompt, next.id);
  return change?.modelOptions ? { prompt: change.prompt, modelOptions: change.modelOptions } : null;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  /** Receives an edit of the live prompt; the picker never holds the prompt text itself. */
  onPromptEdit?: (edit: (prompt: string) => string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
  triggerClassName?: string;
  triggerVariant?: "toolbar" | "settings";
}

export type TraitsSelectionInput = TraitsMenuContentProps & TraitsPersistence;

/** The model's traits with their shown values, and writers that persist a change. */
export function useTraitsSelection({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  triggerClassName: _triggerClassName,
  ...persistence
}: TraitsSelectionInput) {
  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadRef ?? persistence.draftId;
    if (!threadTarget) {
      return;
    }
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
  };
  const selected = getTraitsSectionVisibility({
    provider,
    models,
    model,
    promptUltrathink,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  return {
    ...selected,
    /** The option a select shows, where an Ultrathink prompt owns the primary select. */
    selectValue: (descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>) =>
      selected.ultrathinkPromptControlled && descriptor.id === selected.primarySelectDescriptor?.id
        ? "ultrathink"
        : (getDescriptorStringValue(descriptor, modelSelection, reportedModelSelection) ?? ""),
    currentLabel: (descriptor: ProviderOptionDescriptor) =>
      getProviderOptionCurrentLabel(descriptor, modelSelection, reportedModelSelection),
    changeSelect: (
      descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
      value: string,
    ) => {
      // Whether a pick applies, and the options it writes, do not depend on the prompt text.
      const change = getTraitSelectChange(selected, descriptor, "", value);
      if (!change) return;
      onPromptEdit?.(
        (prompt) => getTraitSelectChange(selected, descriptor, prompt, value)?.prompt ?? prompt,
      );
      updateModelOptions(change.modelOptions);
    },
    changeBoolean: (descriptorId: string, value: boolean) => {
      updateModelOptions(
        buildProviderOptionSelectionsFromDescriptors(
          replaceDescriptorCurrentValue(selected.descriptors, descriptorId, value),
        ),
      );
    },
  };
}

export const ULTRATHINK_IN_BODY_NOTE =
  'Your prompt contains "ultrathink" in the text. Remove it to change this option.';

export function TraitsMenuContent(props: TraitsSelectionInput & { reasoningOnly?: boolean }) {
  const traits = useTraitsSelection(props);
  const {
    descriptors,
    selectDescriptors: allSelectDescriptors,
    booleanDescriptors: allBooleanDescriptors,
    primarySelectDescriptor,
    ultrathinkInBodyText,
    hasAnyControls,
    modelIsUnavailable,
  } = traits;
  const inReasoningMenu = (descriptor: ProviderOptionDescriptor) =>
    !props.reasoningOnly ||
    isReasoningControl(descriptor) ||
    descriptor.id === "serviceTier" ||
    descriptor.id === "fastMode";
  const selectDescriptors = allSelectDescriptors.filter(inReasoningMenu);
  const booleanDescriptors = allBooleanDescriptors.filter(inReasoningMenu);

  if (!hasAnyControls) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.filter(inReasoningMenu).map((descriptor, index) => {
          const value = traits.currentLabel(descriptor);
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 text-muted-foreground text-meta">
                  {descriptor.label}
                </div>
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-meta">{value}</div>
              </MenuGroup>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 text-muted-foreground text-meta">
              {descriptor.label}
            </div>
            {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-meta">
                {ULTRATHINK_IN_BODY_NOTE}
              </div>
            ) : null}
            <MenuRadioGroup
              value={traits.selectValue(descriptor)}
              onValueChange={(value) => traits.changeSelect(descriptor, value)}
            >
              {selectableProviderOptionChoices(descriptor).map((option) => (
                <MenuRadioItem
                  key={option.id}
                  value={option.id}
                  hideIndicator
                  closeOnClick
                  disabled={ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id}
                >
                  <span className="flex w-full min-w-0 flex-col">
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="min-w-0 truncate">{option.label}</span>
                        {option.isDefault ? <DefaultBadge /> : null}
                      </span>
                      <MenuRadioItemIndicator />
                    </span>
                    {option.description ? (
                      <span className="max-w-56 text-pretty text-muted-foreground/80 text-meta">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {booleanDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 text-muted-foreground text-meta">{descriptor.label}</div>
            <MenuRadioGroup
              value={descriptor.currentValue === true ? "on" : "off"}
              onValueChange={(value) => traits.changeBoolean(descriptor.id, value === "on")}
            >
              {(["on", "off"] as const).map((value) => (
                <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                  <span className="flex w-full min-w-0 items-center justify-between gap-3">
                    <span>{value === "on" ? "On" : "Off"}</span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
    </>
  );
}

/** The traits trigger's text ("High", "High · Fast"), or null when the model has no traits. */
export function resolveTraitsTriggerLabel(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions: ProviderOptions | null | undefined;
  planModeEnabled: boolean;
}): string | null {
  const visibility = getTraitsSectionVisibility({
    ...input,
    promptUltrathink: "none",
    allowPromptInjectedEffort: false,
  });
  if (!visibility.hasAnyControls) return null;
  // The trigger label already pairs speed with reasoning ("High Fast").
  const { label } = buildTraitsTriggerDisplay({
    provider: input.provider,
    descriptors: visibility.descriptors,
    primarySelectDescriptorId: visibility.primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
  });
  return label.length > 0 ? label : null;
}

export function TraitsPicker({
  size = "sm",
  hidden = false,
  disabled = false,
  ...props
}: TraitsSelectionInput & {
  size?: ComposerControlSize;
  hidden?: boolean;
  disabled?: boolean;
}) {
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled);
  const traits = useTraitsSelection(props);
  if (!traits.hasAnyControls) {
    return null;
  }
  const { label: triggerLabel } = buildTraitsTriggerDisplay({
    provider: props.provider,
    descriptors: traits.descriptors,
    primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled: traits.ultrathinkPromptControlled,
    modelSelection:
      props.instanceId && props.model
        ? { instanceId: props.instanceId, model: props.model, options: props.modelOptions ?? [] }
        : null,
    reportedModelSelection: props.reportedModelSelection,
  });
  const isCodexStyle = props.provider === "codex";
  const triggerVariant = props.triggerVariant;

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  disabled={disabled}
                  aria-label={triggerLabel}
                  size={size}
                  variant={triggerVariant ?? "toolbar"}
                  className={cn(
                    isCodexStyle
                      ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                      : "shrink-0 whitespace-nowrap",
                    props.triggerClassName,
                  )}
                />
              }
            />
          }
        >
          {isCodexStyle ? (
            <span
              className={cn(
                "flex min-w-0 w-full items-center",
                size === "xs" ? "gap-1" : "gap-1.5",
              )}
            >
              <span data-composer-control-compact-icon className="pointer-events-none">
                <ComposerControlIcon
                  icon={BrainIcon}
                  size={size}
                  className={triggerVariant === "settings" ? "size-3.5" : "size-3"}
                />
              </span>
              <span data-composer-control-label className="min-w-0 truncate">
                {triggerLabel}
              </span>
            </span>
          ) : (
            <>
              <span data-composer-control-compact-icon className="pointer-events-none">
                <ComposerControlIcon
                  icon={BrainIcon}
                  size={size}
                  className={triggerVariant === "settings" ? "size-3.5" : "size-3"}
                />
              </span>
              <span data-composer-control-label>{triggerLabel}</span>
            </>
          )}
          {triggerVariant === "settings" ? (
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
              data-composer-control-chevron
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup spacing="relaxed" align="start">
        <TraitsMenuContent {...props} />
      </MenuPopup>
    </Menu>
  );
}

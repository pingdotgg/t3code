import {
  type ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import {
  BookOpenIcon,
  BrainIcon,
  ChevronDownIcon,
  RabbitIcon,
  TurtleIcon,
  ZapIcon,
} from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";
import { Fragment } from "react";
import { DefaultBadge, SelectedModelBadge } from "./SelectedModelBadge";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

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

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function getBooleanDescriptorLabel(
  descriptor: Extract<ProviderOptionDescriptor, { type: "boolean" }>,
): string {
  return descriptor.id === "fastMode" ? "Speed" : descriptor.label;
}

function getBooleanDescriptorOptionLabel(
  descriptor: Extract<ProviderOptionDescriptor, { type: "boolean" }>,
  value: "on" | "off",
): string {
  if (descriptor.id === "fastMode") {
    return value === "on" ? "Fast" : "Normal";
  }
  return value === "on" ? "On" : "Off";
}

function getSpeedOptionDescription(input: {
  provider: ProviderDriverKind;
  model: string | null | undefined;
  value: "on" | "off";
}): string {
  if (input.value === "off") {
    return "Uses standard speed and normal usage.";
  }
  if (input.provider === "claudeAgent") {
    return "Works up to 2.5x faster, but uses 6x more usage than normal.";
  }
  if (input.model === "gpt-5.5") {
    return "Works up to 1.5x faster, but uses 2.5x more usage than normal.";
  }
  return "Works up to 1.5x faster, but uses 2x more usage than normal.";
}

function BooleanDescriptorOptionIcon(props: {
  descriptor: Extract<ProviderOptionDescriptor, { type: "boolean" }>;
  value: "on" | "off";
}) {
  if (props.descriptor.id !== "fastMode") {
    return null;
  }
  const Icon = props.value === "on" ? RabbitIcon : TurtleIcon;
  return <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
}

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({
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

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const fastModeEnabled =
    typeof fastModeDescriptor?.currentValue === "boolean" ? fastModeDescriptor.currentValue : false;
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
    fastModeEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
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
    hasAnyControls: showEffort || showThinking || showFastMode || showContextWindow || showAgent,
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  hiddenDescriptorIds?: ReadonlyArray<string>;
}): boolean {
  const visibility = getTraitsSectionVisibility(input);
  if (!visibility.hasAnyControls) return false;
  const hidden = new Set(input.hiddenDescriptorIds ?? []);
  if (hidden.size === 0) return true;
  return visibility.descriptors.some((descriptor) => !hidden.has(descriptor.id));
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  hiddenDescriptorIds?: ReadonlyArray<string>;
  showTriggerSeparators?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onRequestClose?: () => void;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  hiddenDescriptorIds,
  onRequestClose,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        model,
        persistSticky: true,
      });
    },
    [model, persistence, provider, setProviderModelOptions],
  );
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  const hiddenDescriptorIdSet = new Set(hiddenDescriptorIds ?? []);
  const visibleDescriptors = descriptors.filter(
    (descriptor) => !hiddenDescriptorIdSet.has(descriptor.id),
  );
  const visibleSelectDescriptors = selectDescriptors.filter(
    (descriptor) => !hiddenDescriptorIdSet.has(descriptor.id),
  );
  const visibleBooleanDescriptors = booleanDescriptors.filter(
    (descriptor) => !hiddenDescriptorIdSet.has(descriptor.id),
  );
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;
    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
    onRequestClose?.();
  };

  if (!hasAnyControls || visibleDescriptors.length === 0) {
    return null;
  }

  return (
    <>
      {visibleSelectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                option.
              </div>
            ) : null}
            {(() => {
              const selectedValue =
                ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
                  ? "ultrathink"
                  : (getDescriptorStringValue(descriptor) ?? "");
              return (
                <MenuRadioGroup
                  value={selectedValue}
                  onValueChange={(value) => handleSelectChange(descriptor, value)}
                >
                  {descriptor.options.map((option) => (
                    <MenuRadioItem
                      key={option.id}
                      value={option.id}
                      hideIndicator
                      disabled={
                        ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {option.label}
                        {option.isDefault ? <DefaultBadge /> : null}
                        {option.id === selectedValue ? <SelectedModelBadge /> : null}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              );
            })()}
          </MenuGroup>
        </div>
      ))}
      {visibleBooleanDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 || visibleSelectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {getBooleanDescriptorLabel(descriptor)}
            </div>
            {(() => {
              const selectedValue = descriptor.currentValue === true ? "on" : "off";
              return (
                <MenuRadioGroup
                  value={selectedValue}
                  onValueChange={(value) => {
                    updateDescriptors(
                      replaceDescriptorCurrentValue(descriptors, descriptor.id, value === "on"),
                    );
                    onRequestClose?.();
                  }}
                >
                  {(["on", "off"] as const).map((value) => (
                    <MenuRadioItem
                      key={value}
                      value={value}
                      hideIndicator
                      className={descriptor.id === "fastMode" ? "min-w-72 items-start py-2" : ""}
                    >
                      <span className="grid min-w-0 gap-0.5">
                        <span className="inline-flex items-center gap-1.5">
                          <BooleanDescriptorOptionIcon descriptor={descriptor} value={value} />
                          {getBooleanDescriptorOptionLabel(descriptor, value)}
                          {value === selectedValue ? <SelectedModelBadge /> : null}
                        </span>
                        {descriptor.id === "fastMode" ? (
                          <span className="text-muted-foreground text-xs leading-4">
                            {getSpeedOptionDescription({ provider, model, value })}
                          </span>
                        ) : null}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              );
            })()}
          </MenuGroup>
        </div>
      ))}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  hiddenDescriptorIds,
  showTriggerSeparators = true,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    });
  const hiddenDescriptorIdSet = new Set(hiddenDescriptorIds ?? []);
  const visibleDescriptors = descriptors.filter(
    (descriptor) => !hiddenDescriptorIdSet.has(descriptor.id),
  );
  const isCodexStyle = provider === "codex";
  const [openDescriptorId, setOpenDescriptorId] = useState<string | null>(null);

  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        model,
        persistSticky: true,
      });
    },
    [model, persistence, provider, setProviderModelOptions],
  );

  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    }) ||
    visibleDescriptors.length === 0
  ) {
    return null;
  }

  return (
    <>
      {visibleDescriptors.map((descriptor, descriptorIndex) => {
        const resolvedSelectLabel = getProviderOptionCurrentLabel(descriptor);
        const descriptorIdLower = descriptor.id.toLowerCase();
        const descriptorLabelLower = descriptor.label.toLowerCase();
        const isThinkingLike =
          descriptorIdLower.includes("reason") ||
          descriptorLabelLower.includes("reason") ||
          descriptorIdLower === "variant" ||
          descriptorLabelLower === "variant" ||
          descriptorIdLower.includes("thinking") ||
          descriptorLabelLower.includes("thinking");
        const triggerLabel =
          ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
            ? "Ultrathink"
            : descriptor.type === "boolean"
              ? descriptor.id === "fastMode"
                ? descriptor.currentValue === true
                  ? "Fast"
                  : "Normal"
                : isThinkingLike
                  ? descriptor.currentValue === true
                    ? "On"
                    : "Off"
                  : `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
              : resolvedSelectLabel && resolvedSelectLabel.length > 0
                ? resolvedSelectLabel
                : descriptor.label;
        const isContextWindow =
          descriptorIdLower === "contextwindow" ||
          descriptorIdLower === "context_window" ||
          descriptorIdLower.includes("contextwindow") ||
          descriptorLabelLower.includes("context window");
        const TriggerIcon =
          descriptor.id === "fastMode"
            ? ZapIcon
            : isThinkingLike
              ? BrainIcon
              : isContextWindow
                ? BookOpenIcon
                : null;
        const popupHiddenDescriptorIds = [
          ...(hiddenDescriptorIds ?? []),
          ...visibleDescriptors
            .filter((visibleDescriptor) => visibleDescriptor.id !== descriptor.id)
            .map((visibleDescriptor) => visibleDescriptor.id),
        ];

        const isBooleanToggle = descriptor.type === "boolean" && isThinkingLike;
        const toggleOn = isBooleanToggle && descriptor.currentValue === true;
        const toggleLabel = toggleOn ? "Thinking" : "Instant";

        return (
          <Fragment key={descriptor.id}>
            {showTriggerSeparators && descriptorIndex > 0 ? (
              <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
            ) : null}
            {isBooleanToggle ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-pressed={toggleOn}
                title={
                  toggleOn
                    ? "Thinking enabled - click to switch to instant responses"
                    : "Instant responses - click to enable thinking"
                }
                onClick={() => {
                  updateModelOptions(
                    buildProviderOptionSelectionsFromDescriptors(
                      replaceDescriptorCurrentValue(descriptors, descriptor.id, !toggleOn),
                    ),
                  );
                }}
                className={cn(
                  "shrink-0 whitespace-nowrap px-2 sm:px-3",
                  toggleOn
                    ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                    : "text-muted-foreground/70 hover:text-foreground/80",
                  triggerClassName,
                )}
              >
                <BrainIcon
                  aria-hidden="true"
                  className={cn("size-3.5", toggleOn ? "text-current opacity-100" : "opacity-70")}
                />
                <span className="sr-only sm:not-sr-only">{toggleLabel}</span>
              </Button>
            ) : (
              <Menu
                open={openDescriptorId === descriptor.id}
                onOpenChange={(open) => setOpenDescriptorId(open ? descriptor.id : null)}
              >
                <MenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant={triggerVariant ?? "ghost"}
                      className={cn(
                        isCodexStyle
                          ? "min-w-0 max-w-40 shrink justify-between whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3"
                          : "shrink-0 justify-between whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
                        triggerClassName,
                      )}
                    />
                  }
                >
                  <span className="flex min-w-0 flex-1 justify-center items-center gap-1.5 overflow-hidden">
                    {TriggerIcon ? (
                      <TriggerIcon aria-hidden="true" className="ps-[2px] opacity-70" />
                    ) : null}
                    <span className="min-w-0 truncate">{triggerLabel}</span>
                  </span>
                  <span aria-hidden="true" className="flex items-center">
                    <ChevronDownIcon
                      aria-hidden="true"
                      className="!ms-0 !-me-1 size-3 shrink-0 opacity-60"
                    />
                  </span>
                </MenuTrigger>
                <MenuPopup align="start">
                  <TraitsMenuContent
                    provider={provider}
                    models={models}
                    model={model}
                    prompt={prompt}
                    onPromptChange={onPromptChange}
                    modelOptions={modelOptions}
                    allowPromptInjectedEffort={allowPromptInjectedEffort}
                    hiddenDescriptorIds={popupHiddenDescriptorIds}
                    onRequestClose={() => setOpenDescriptorId(null)}
                    {...persistence}
                  />
                </MenuPopup>
              </Menu>
            )}
          </Fragment>
        );
      })}
    </>
  );
});

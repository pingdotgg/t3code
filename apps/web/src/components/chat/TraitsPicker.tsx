import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type OpenCodeModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  isClaudeUltrathinkPrompt,
  trimOrNull,
  getDefaultEffort,
  getDefaultContextWindow,
  hasContextWindowOption,
  resolveEffort,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
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

type ProviderOptions = ProviderModelOptions[ProviderKind];
type NamedOption = {
  value: string;
  label: string;
  isDefault?: boolean | undefined;
};

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

function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  if (provider === "cursor") {
    return trimOrNull((modelOptions as CursorModelOptions | undefined)?.reasoning);
  }
  if (provider === "opencode") {
    return trimOrNull((modelOptions as OpenCodeModelOptions | undefined)?.variant);
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
}

function getEffortKey(provider: ProviderKind): string {
  if (provider === "codex") return "reasoningEffort";
  if (provider === "cursor") return "reasoning";
  if (provider === "opencode") return "variant";
  return "effort";
}

function getRawAgent(modelOptions: ProviderOptions | null | undefined): string | null {
  return trimOrNull((modelOptions as OpenCodeModelOptions | undefined)?.agent);
}

function resolveNamedOption(
  options: ReadonlyArray<NamedOption>,
  raw: string | null,
): NamedOption | null {
  if (raw) {
    const matchingOption = options.find((option) => option.value === raw);
    if (matchingOption) {
      return matchingOption;
    }
  }
  return options.find((option) => option.isDefault) ?? options[0] ?? null;
}

function getRawContextWindow(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (modelOptions && "contextWindow" in modelOptions) {
    return trimOrNull(modelOptions.contextWindow);
  }
  return null;
}

function buildNextOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  return { ...(modelOptions as Record<string, unknown> | undefined), ...patch } as ProviderOptions;
}

function getSelectedTraits(
  provider: ProviderKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const effortLevels =
    provider === "opencode"
      ? (caps.variantOptions ?? [])
      : allowPromptInjectedEffort
        ? caps.reasoningEffortLevels
        : caps.reasoningEffortLevels.filter(
            (option) => !caps.promptInjectedEffortLevels.includes(option.value),
          );

  // Resolve effort from options (provider-specific key)
  const rawEffort = getRawEffort(provider, modelOptions);
  const effort =
    provider === "opencode"
      ? (resolveNamedOption(effortLevels, rawEffort)?.value ?? null)
      : (resolveEffort(caps, rawEffort) ?? null);

  // Thinking toggle (only for models that support it)
  const thinkingEnabled = caps.supportsThinkingToggle
    ? modelOptions && "thinking" in modelOptions
      ? modelOptions.thinking === true
      : null
    : null;

  // Fast mode
  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;

  // Context window
  const contextWindowOptions = caps.contextWindowOptions;
  const rawContextWindow = getRawContextWindow(provider, modelOptions);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    caps.promptInjectedEffortLevels.length > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));

  const agentOptions = caps.agentOptions ?? [];
  const selectedAgentOption =
    provider === "opencode" ? resolveNamedOption(agentOptions, getRawAgent(modelOptions)) : null;

  return {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    agentOptions,
    selectedAgent: selectedAgentOption?.value ?? null,
    selectedAgentLabel: selectedAgentOption?.label ?? null,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderKind;
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

  const showEffort = selected.effort !== null;
  const showThinking = selected.thinkingEnabled !== null;
  const showFastMode = selected.caps.supportsFastMode;
  const showContextWindow = selected.contextWindowOptions.length > 1;
  const showAgent = selected.agentOptions.length > 0;

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
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
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
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    ultrathinkInBodyText,
    agentOptions,
    selectedAgent,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  const defaultEffort = getDefaultEffort(caps);
  const showsEffortSection = showEffort;
  const showsThinkingSection = !showEffort && showThinking;
  const showsFastModeSection = showFastMode;
  const showsContextWindowSection = showContextWindow;
  const hasSectionsBeforeAgent =
    showsEffortSection || showsThinkingSection || showsFastModeSection || showsContextWindowSection;

  const handleEffortChange = useCallback(
    (value: string) => {
      if (!value) return;
      const nextOption = effortLevels.find((option) => option.value === value);
      if (!nextOption) return;
      if (provider === "opencode") {
        updateModelOptions(buildNextOptions(provider, modelOptions, { variant: nextOption.value }));
        return;
      }
      if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
        const nextPrompt =
          prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(prompt, "ultrathink");
        onPromptChange(nextPrompt);
        return;
      }
      if (ultrathinkInBodyText) return;
      if (ultrathinkPromptControlled) {
        const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
        onPromptChange(stripped);
      }
      const effortKey = getEffortKey(provider);
      updateModelOptions(
        buildNextOptions(provider, modelOptions, { [effortKey]: nextOption.value }),
      );
    },
    [
      ultrathinkPromptControlled,
      ultrathinkInBodyText,
      modelOptions,
      onPromptChange,
      updateModelOptions,
      effortLevels,
      prompt,
      caps.promptInjectedEffortLevels,
      provider,
    ],
  );

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {showsEffortSection ? (
        <>
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {provider === "opencode" ? "Variant" : "Effort"}
            </div>
            {ultrathinkInBodyText ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change effort.
              </div>
            ) : null}
            <MenuRadioGroup
              value={ultrathinkPromptControlled ? "ultrathink" : effort}
              onValueChange={handleEffortChange}
            >
              {effortLevels.map((option) => (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={ultrathinkInBodyText}
                >
                  {option.label}
                  {(provider === "opencode" ? option.isDefault : option.value === defaultEffort)
                    ? " (default)"
                    : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : showsThinkingSection ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "off"}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextOptions(provider, modelOptions, { thinking: value === "on" }),
              );
            }}
          >
            <MenuRadioItem value="on">On (default)</MenuRadioItem>
            <MenuRadioItem value="off">Off</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {showsFastModeSection ? (
        <>
          {showsEffortSection || showsThinkingSection ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, { fastMode: value === "on" }),
                );
              }}
            >
              <MenuRadioItem value="off">off</MenuRadioItem>
              <MenuRadioItem value="on">on</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {showsContextWindowSection ? (
        <>
          {showsEffortSection || showsThinkingSection || showsFastModeSection ? (
            <MenuDivider />
          ) : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Context Window
            </div>
            <MenuRadioGroup
              value={contextWindow ?? defaultContextWindow ?? ""}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    contextWindow: value,
                  }),
                );
              }}
            >
              {contextWindowOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                  {option.value === defaultContextWindow ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {agentOptions.length > 0 ? (
        <>
          {hasSectionsBeforeAgent ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agent</div>
            <MenuRadioGroup
              value={selectedAgent ?? ""}
              onValueChange={(value) => {
                updateModelOptions(buildNextOptions(provider, modelOptions, { agent: value }));
              }}
            >
              {agentOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                  {option.isDefault ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
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
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    showEffort,
    showThinking,
    showContextWindow,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  const { selectedAgentLabel } = getSelectedTraits(
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  );

  const effortLabel = effort
    ? (effortLevels.find((l) => l.value === effort)?.label ?? effort)
    : null;
  const primaryTraitLabel = ultrathinkPromptControlled
    ? "Ultrathink"
    : effortLabel
      ? effortLabel
      : thinkingEnabled === null
        ? null
        : `Thinking ${thinkingEnabled ? "On" : "Off"}`;
  const contextWindowLabel =
    showContextWindow && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((o) => o.value === contextWindow)?.label ?? null)
      : null;
  const fastOnlyControl =
    caps.supportsFastMode && !showEffort && !showThinking && !showContextWindow;
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    })
  ) {
    return null;
  }

  const selectedTriggerTraits = [
    primaryTraitLabel,
    ...(caps.supportsFastMode &&
    (fastModeEnabled || (primaryTraitLabel === null && contextWindowLabel !== null))
      ? [fastModeEnabled ? "Fast" : "Normal"]
      : []),
    ...(contextWindowLabel ? [contextWindowLabel] : []),
    ...(selectedAgentLabel ? [selectedAgentLabel] : []),
  ].filter(Boolean);
  const triggerLabel = fastOnlyControl
    ? fastModeEnabled
      ? "Fast"
      : "Normal"
    : selectedTriggerTraits.length > 0
      ? selectedTriggerTraits.join(" · ")
      : caps.supportsFastMode
        ? "Normal"
        : defaultContextWindow
          ? (contextWindowOptions.find((option) => option.value === defaultContextWindow)?.label ??
            defaultContextWindow)
          : (selectedAgentLabel ?? "");

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {triggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        ) : (
          <>
            <span>{triggerLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </>
        )}
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
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});

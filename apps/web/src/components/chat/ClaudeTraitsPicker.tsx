import {
  type ClaudeCodeEffort,
  type ClaudeModelOptions,
  type ProviderModelOptions,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeClaudeModelOptions,
  resolveReasoningEffortForProvider,
  supportsClaudeFastMode,
  supportsClaudeThinkingToggle,
  supportsClaudeUltrathinkKeyword,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";

const CLAUDE_EFFORT_LABELS: Record<ClaudeCodeEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
  ultrathink: "Ultrathink",
};

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function getSelectedClaudeTraits(
  model: string | null | undefined,
  prompt: string,
  modelOptions: ClaudeModelOptions | null | undefined,
): {
  effort: Exclude<ClaudeCodeEffort, "ultrathink"> | null;
  thinkingEnabled: boolean | null;
  fastModeEnabled: boolean;
  options: ReadonlyArray<ClaudeCodeEffort>;
  ultrathinkPromptControlled: boolean;
  supportsFastMode: boolean;
} {
  const options = getReasoningEffortOptions("claudeAgent", model);
  const defaultReasoningEffort = getDefaultReasoningEffort("claudeAgent") as Exclude<
    ClaudeCodeEffort,
    "ultrathink"
  >;
  const resolvedEffort = resolveReasoningEffortForProvider("claudeAgent", modelOptions?.effort);
  const effort =
    resolvedEffort && resolvedEffort !== "ultrathink" && options.includes(resolvedEffort)
      ? resolvedEffort
      : options.includes(defaultReasoningEffort)
        ? defaultReasoningEffort
        : null;
  const thinkingEnabled = supportsClaudeThinkingToggle(model)
    ? (modelOptions?.thinking ?? true)
    : null;
  const supportsFastMode = supportsClaudeFastMode(model);
  return {
    effort,
    thinkingEnabled,
    fastModeEnabled: supportsFastMode && modelOptions?.fastMode === true,
    options,
    ultrathinkPromptControlled:
      supportsClaudeUltrathinkKeyword(model) && isClaudeUltrathinkPrompt(prompt),
    supportsFastMode,
  };
}

function ClaudeTraitsMenuContentImpl(props: {
  threadId: ThreadId;
  model: string | null | undefined;
  onPromptChange: (prompt: string) => void;
}) {
  const draft = useComposerThreadDraft(props.threadId);
  const prompt = draft.prompt;
  const modelOptions = draft.modelOptions?.claudeAgent;
  const setModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const {
    effort,
    thinkingEnabled,
    fastModeEnabled,
    options,
    ultrathinkPromptControlled,
    supportsFastMode,
  } = getSelectedClaudeTraits(props.model, prompt, modelOptions);
  const defaultReasoningEffort = getDefaultReasoningEffort("claudeAgent");

  const setClaudeModelOptions = (nextClaudeModelOptions: ClaudeModelOptions | undefined) => {
    const { claudeAgent: _discardedClaude, ...otherProviderModelOptions } =
      draft.modelOptions ?? {};
    const nextProviderModelOptions: ProviderModelOptions | undefined = nextClaudeModelOptions
      ? { ...otherProviderModelOptions, claudeAgent: nextClaudeModelOptions }
      : Object.keys(otherProviderModelOptions).length > 0
        ? otherProviderModelOptions
        : undefined;
    setModelOptions(props.threadId, nextProviderModelOptions);
  };

  if (effort === null && thinkingEnabled === null) {
    return null;
  }

  return (
    <>
      {effort ? (
        <>
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Effort</div>
            {ultrathinkPromptControlled ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Remove Ultrathink from the prompt to change effort.
              </div>
            ) : null}
            <MenuRadioGroup
              value={effort}
              onValueChange={(value) => {
                if (ultrathinkPromptControlled) return;
                if (!value) return;
                const nextEffort = options.find((option) => option === value);
                if (!nextEffort) return;
                if (nextEffort === "ultrathink") {
                  const nextPrompt =
                    prompt.trim().length === 0
                      ? ULTRATHINK_PROMPT_PREFIX
                      : applyClaudePromptEffortPrefix(prompt, "ultrathink");
                  props.onPromptChange(nextPrompt);
                  return;
                }
                setClaudeModelOptions(
                  normalizeClaudeModelOptions(props.model, {
                    ...modelOptions,
                    effort: nextEffort,
                  }),
                );
              }}
            >
              {options.map((option) => (
                <MenuRadioItem key={option} value={option} disabled={ultrathinkPromptControlled}>
                  {CLAUDE_EFFORT_LABELS[option]}
                  {option === defaultReasoningEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : thinkingEnabled !== null ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "off"}
            onValueChange={(value) => {
              setClaudeModelOptions(
                normalizeClaudeModelOptions(props.model, {
                  ...modelOptions,
                  thinking: value === "on",
                }),
              );
            }}
          >
            <MenuRadioItem value="on">On (default)</MenuRadioItem>
            <MenuRadioItem value="off">Off</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                setClaudeModelOptions(
                  normalizeClaudeModelOptions(props.model, {
                    ...modelOptions,
                    fastMode: value === "on",
                  }),
                );
              }}
            >
              <MenuRadioItem value="off">off</MenuRadioItem>
              <MenuRadioItem value="on">on</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
    </>
  );
}

export const ClaudeTraitsMenuContent = memo(ClaudeTraitsMenuContentImpl);

export const ClaudeTraitsPicker = memo(function ClaudeTraitsPicker(props: {
  threadId: ThreadId;
  model: string | null | undefined;
  onPromptChange: (prompt: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const draft = useComposerThreadDraft(props.threadId);
  const prompt = draft.prompt;
  const modelOptions = draft.modelOptions?.claudeAgent;
  const { effort, thinkingEnabled, fastModeEnabled, ultrathinkPromptControlled, supportsFastMode } =
    getSelectedClaudeTraits(props.model, prompt, modelOptions);
  const triggerLabel = [
    ultrathinkPromptControlled
      ? "Ultrathink"
      : effort
        ? CLAUDE_EFFORT_LABELS[effort]
        : thinkingEnabled === null
          ? null
          : `Thinking ${thinkingEnabled ? "On" : "Off"}`,
    ...(supportsFastMode && fastModeEnabled ? ["Fast"] : []),
  ]
    .filter(Boolean)
    .join(" · ");

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
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{triggerLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <ClaudeTraitsMenuContent
          threadId={props.threadId}
          model={props.model}
          onPromptChange={props.onPromptChange}
        />
      </MenuPopup>
    </Menu>
  );
});

import type {
  CodexModelOptions,
  CodexReasoningEffort,
  ProviderModelOptions,
  ThreadId,
} from "@t3tools/contracts";
import {
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeCodexModelOptions,
  resolveReasoningEffortForProvider,
} from "@t3tools/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
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

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function getSelectedCodexTraits(modelOptions: CodexModelOptions | null | undefined): {
  effort: CodexReasoningEffort;
  fastModeEnabled: boolean;
} {
  const defaultReasoningEffort = getDefaultReasoningEffort("codex");
  return {
    effort:
      resolveReasoningEffortForProvider("codex", modelOptions?.reasoningEffort) ??
      defaultReasoningEffort,
    fastModeEnabled: modelOptions?.fastMode === true,
  };
}

function CodexTraitsMenuContentImpl(props: { threadId: ThreadId }) {
  const draft = useComposerThreadDraft(props.threadId);
  const modelOptions = draft.modelOptions?.codex;
  const setModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const options = getReasoningEffortOptions("codex");
  const defaultReasoningEffort = getDefaultReasoningEffort("codex");
  const { effort, fastModeEnabled } = getSelectedCodexTraits(modelOptions);

  const setCodexModelOptions = (nextCodexModelOptions: CodexModelOptions | undefined) => {
    const { codex: _discardedCodex, ...otherProviderModelOptions } = draft.modelOptions ?? {};
    const nextProviderModelOptions: ProviderModelOptions | undefined = nextCodexModelOptions
      ? { ...otherProviderModelOptions, codex: nextCodexModelOptions }
      : Object.keys(otherProviderModelOptions).length > 0
        ? otherProviderModelOptions
        : undefined;
    setModelOptions(props.threadId, nextProviderModelOptions);
  };

  return (
    <>
      <MenuGroup>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
        <MenuRadioGroup
          value={effort}
          onValueChange={(value) => {
            if (!value) return;
            const nextEffort = options.find((option) => option === value);
            if (!nextEffort) return;
            setCodexModelOptions(
              normalizeCodexModelOptions({
                ...modelOptions,
                reasoningEffort: nextEffort,
              }),
            );
          }}
        >
          {options.map((option) => (
            <MenuRadioItem key={option} value={option}>
              {CODEX_REASONING_LABELS[option]}
              {option === defaultReasoningEffort ? " (default)" : ""}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuDivider />
      <MenuGroup>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
        <MenuRadioGroup
          value={fastModeEnabled ? "on" : "off"}
          onValueChange={(value) => {
            setCodexModelOptions(
              normalizeCodexModelOptions({
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
  );
}

export const CodexTraitsMenuContent = memo(CodexTraitsMenuContentImpl);

export const CodexTraitsPicker = memo(function CodexTraitsPicker(props: { threadId: ThreadId }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const modelOptions = useComposerThreadDraft(props.threadId).modelOptions?.codex;
  const { effort, fastModeEnabled } = getSelectedCodexTraits(modelOptions);
  const triggerLabel = [CODEX_REASONING_LABELS[effort], ...(fastModeEnabled ? ["Fast"] : [])]
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
            className="min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {triggerLabel}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <CodexTraitsMenuContent threadId={props.threadId} />
      </MenuPopup>
    </Menu>
  );
});

import { SparklesIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Inline chip for a model the prompt names, in the composer and in sent messages. */
export function ModelContextChip(props: { label: string; copyMarkdown?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="model"
            tabIndex={0}
            aria-label={`Model, ${props.label}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <SparklesIcon />
            <ContextChipLabel>{props.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">Model</TooltipPopup>
    </Tooltip>
  );
}

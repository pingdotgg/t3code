import { TerminalIcon, XIcon } from "lucide-react";

import { type TerminalContextDraft, formatTerminalContextLabel } from "~/lib/terminalContext";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerPendingTerminalContextsProps {
  contexts: ReadonlyArray<TerminalContextDraft>;
  onRemove: (contextId: string) => void;
}

export function ComposerPendingTerminalContexts(props: ComposerPendingTerminalContextsProps) {
  const { contexts, onRemove } = props;

  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {contexts.map((context) => {
        const label = formatTerminalContextLabel(context);
        return (
          <Tooltip key={context.id}>
            <TooltipTrigger
              render={
                <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/75 bg-background/80 px-3 py-1.5 text-xs text-foreground shadow-xs">
                  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/70 text-muted-foreground">
                    <TerminalIcon className="size-3" />
                  </span>
                  <span className="truncate font-medium">{label}</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="-mr-1 size-5 rounded-full"
                    onClick={() => onRemove(context.id)}
                    aria-label={`Remove ${label}`}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              }
            />
            <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
              {context.text}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

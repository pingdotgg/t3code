"use client";

import { CopyIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ProviderSetupCommandRowProps {
  readonly command: string;
  readonly label: string;
  readonly onCopy: (command: string, label: string) => void;
}

export function ProviderSetupCommandRow(props: ProviderSetupCommandRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/30 py-0.5 pr-0.5 pl-2">
      <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
        <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
          {props.command}
        </code>
      </ScrollArea>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              onClick={() => props.onCopy(props.command, props.label)}
              aria-label={`Copy ${props.label}`}
            >
              <CopyIcon className="size-3" />
            </Button>
          }
        />
        <TooltipPopup side="top">Copy command</TooltipPopup>
      </Tooltip>
    </div>
  );
}

interface HermesSetupSectionProps {
  readonly suggestedBinaryPath: string | undefined;
  readonly onApplySuggestedPath: (path: string) => void;
  readonly onCopyCommand: (command: string, label: string) => void;
}

export function HermesSetupSection(props: HermesSetupSectionProps) {
  const { suggestedBinaryPath, onApplySuggestedPath, onCopyCommand } = props;

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="grid gap-3">
        <div className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Hermes setup</span>
          <p className="text-xs leading-snug text-muted-foreground">
            T3 Code starts Hermes through ACP. Configure Hermes once, then verify the ACP command
            before sending a turn.
          </p>
        </div>
        {suggestedBinaryPath ? (
          <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2">
            <span className="text-xs text-muted-foreground">
              Detected Hermes at <code className="text-foreground">{suggestedBinaryPath}</code>
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="w-fit"
              onClick={() => onApplySuggestedPath(suggestedBinaryPath)}
              aria-label="Use detected Hermes path"
            >
              Use detected path
            </Button>
          </div>
        ) : null}
        <div className="grid gap-2">
          <ProviderSetupCommandRow
            command="hermes model"
            label="Hermes setup command"
            onCopy={onCopyCommand}
          />
          <ProviderSetupCommandRow
            command="hermes acp"
            label="Hermes ACP verification command"
            onCopy={onCopyCommand}
          />
        </div>
        <a
          href="docs/providers/hermes.md"
          target="_blank"
          rel="noreferrer"
          className="w-fit text-xs font-medium text-primary hover:underline"
        >
          Hermes setup docs
        </a>
      </div>
    </div>
  );
}

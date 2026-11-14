import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { TRIAGE_CLI_COMMAND } from "~/hooks/useStartTriage";

import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The empty-draft hero for a triage session, in place of "What should we work on?".
 * Keeps the regular hero's heading-plus-one-line rhythm above the composer.
 */
export function TriageDraftHero(props: {
  readonly machineLabel: string | null;
  readonly serverVersion: string | null;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "command" });
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        What went wrong?
      </h1>
      <p className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-sm">
        <Tooltip>
          <TooltipTrigger
            render={<span tabIndex={0} className="min-w-0 truncate font-medium text-foreground" />}
          >
            {props.machineLabel ?? "This machine"}
            {props.serverVersion === null ? null : (
              <span className="ml-1.5 font-normal text-muted-foreground">
                v{props.serverVersion}
              </span>
            )}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            The agent reads T3 Code's logs and source here, and asks before it applies a fix or
            posts anything.
          </TooltipPopup>
        </Tooltip>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <InlineButton
                tone="muted"
                className="pointer-events-auto"
                onClick={() => copyToClipboard(TRIAGE_CLI_COMMAND, undefined)}
              />
            }
          >
            {isCopied ? "Copied" : "or run"}
            {isCopied ? null : <code className="ml-1 font-mono text-xs">{TRIAGE_CLI_COMMAND}</code>}
          </TooltipTrigger>
          <TooltipPopup side="bottom">Copy command, for a terminal</TooltipPopup>
        </Tooltip>
      </p>
    </div>
  );
}

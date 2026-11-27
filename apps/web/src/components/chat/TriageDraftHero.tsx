import { msg, T, Var } from "gt-react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { TRIAGE_CLI_COMMAND } from "~/hooks/useStartTriage";

import { InlineButton } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/**
 * The empty-draft hero for a triage session, in place of "What should we work on?".
 * Keeps the regular hero's heading-plus-one-line rhythm above the composer.
 */
export function TriageDraftHero(props: {
  readonly machineLabel: string | null;
  readonly serverVersion: string | null;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: {
      target: "command",
      unavailableMessage: msg("Clipboard API is unavailable while copying command."),
      failureMessage: msg("Failed to copy command to the clipboard."),
    },
  });
  return (
    <div className="mx-auto flex w-full max-w-110 flex-col items-center">
      <h1 className="w-full text-center text-title text-foreground">
        <T>What went wrong?</T>
      </h1>
      <p className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-label">
        <SharedTooltipTrigger
          render={<span tabIndex={0} className="min-w-0 truncate text-label text-foreground" />}
          label={
            <T>
              The agent reads T3 Code's logs and source here, and asks before it applies a fix or
              posts anything.
            </T>
          }
          side="bottom"
        >
          {props.machineLabel ?? <T>This machine</T>}
          {props.serverVersion === null ? null : (
            <span className="ml-1.5 text-muted-foreground">v{props.serverVersion}</span>
          )}
        </SharedTooltipTrigger>
        <SharedTooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() => copyToClipboard(TRIAGE_CLI_COMMAND, undefined)}
            />
          }
          label={<T>Copy command, for a terminal</T>}
          side="bottom"
        >
          {isCopied ? (
            <T>Copied</T>
          ) : (
            <T>
              or run
              <code className="ml-1 font-mono text-caption">
                <Var>{TRIAGE_CLI_COMMAND}</Var>
              </code>
            </T>
          )}
        </SharedTooltipTrigger>
      </p>
    </div>
  );
}

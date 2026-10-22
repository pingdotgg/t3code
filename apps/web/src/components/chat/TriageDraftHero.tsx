import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { TRIAGE_CLI_COMMAND } from "~/hooks/useStartTriage";

import { InlineButton } from "../ui/button";

/** The empty-draft hero for a triage session, in place of "What should we work on?". */
export function TriageDraftHero(props: {
  readonly machineLabel: string | null;
  readonly serverVersion: string | null;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "command" });
  const where = props.machineLabel === null ? "this machine" : props.machineLabel;
  const version = props.serverVersion === null ? "" : ` (v${props.serverVersion})`;
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center text-center">
      <h1 className="font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        What went wrong?
      </h1>
      <p className="mt-2 text-muted-foreground text-sm">
        The agent checks the T3 Code logs and source on {where}
        {version}, then helps you file an issue. It asks before it changes anything.
      </p>
      <p className="mt-1 text-muted-foreground/70 text-xs">
        Not working here? Run{" "}
        <InlineButton
          tone="muted"
          className="pointer-events-auto"
          onClick={() => copyToClipboard(TRIAGE_CLI_COMMAND, undefined)}
        >
          <code className="font-mono">{isCopied ? "copied" : TRIAGE_CLI_COMMAND}</code>
        </InlineButton>{" "}
        in a terminal.
      </p>
    </div>
  );
}

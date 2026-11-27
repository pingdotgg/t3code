import { type TerminalContextDraft, isTerminalContextExpired } from "~/lib/terminalContext";
import type { ContextPresentationCapability } from "../contextPresentationRegistry";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

interface ComposerPendingTerminalContextChipProps {
  context: TerminalContextDraft;
  detailsMode: ContextPresentationCapability["details"];
}

export function ComposerPendingTerminalContextChip({
  context,
  detailsMode,
}: ComposerPendingTerminalContextChipProps) {
  const expired = isTerminalContextExpired(context);

  return (
    <TerminalContextInlineChip
      terminalLabel={context.terminalLabel}
      lineStart={context.lineStart}
      lineEnd={context.lineEnd}
      text={context.text}
      expired={expired}
      detailsMode={detailsMode}
    />
  );
}

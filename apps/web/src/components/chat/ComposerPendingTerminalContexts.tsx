import {
  type TerminalContextDraft,
  formatTerminalContextLabel,
  isTerminalContextExpired,
} from "~/lib/terminalContext";
import type { ContextPresentationCapability } from "../contextPresentationRegistry";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { definePluginComponent } from "~/plugins/features";

export const ComposerPendingTerminalContextChip = definePluginComponent(
  "component:components/chat/ComposerPendingTerminalContexts/ComposerPendingTerminalContextChip",
  PluginOriginalComposerPendingTerminalContextChip,
);

interface ComposerPendingTerminalContextChipProps {
  context: TerminalContextDraft;
  detailsMode: ContextPresentationCapability["details"];
}

function PluginOriginalComposerPendingTerminalContextChip({
  context,
  detailsMode,
}: ComposerPendingTerminalContextChipProps) {
  const label = formatTerminalContextLabel(context);
  const expired = isTerminalContextExpired(context);

  return (
    <TerminalContextInlineChip
      label={label}
      terminalLabel={context.terminalLabel}
      lineStart={context.lineStart}
      lineEnd={context.lineEnd}
      text={context.text}
      expired={expired}
      detailsMode={detailsMode}
    />
  );
}

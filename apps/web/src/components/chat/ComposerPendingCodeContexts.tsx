import { cn } from "~/lib/utils";
import { formatCodeContextLabel, type CodeContextDraft } from "~/lib/codeContext";
import { CodeContextInlineChip } from "./CodeContextInlineChip";

interface ComposerPendingCodeContextsProps {
  contexts: ReadonlyArray<CodeContextDraft>;
  className?: string;
}

interface ComposerPendingCodeContextChipProps {
  context: CodeContextDraft;
}

export function ComposerPendingCodeContextChip({ context }: ComposerPendingCodeContextChipProps) {
  const tooltipText =
    context.text.length > 0
      ? `${formatCodeContextLabel(context)}\n${context.text}`
      : formatCodeContextLabel(context);

  return <CodeContextInlineChip selection={context} tooltipText={tooltipText} />;
}

export function ComposerPendingCodeContexts(props: ComposerPendingCodeContextsProps) {
  const { contexts, className } = props;

  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingCodeContextChip key={context.id} context={context} />
      ))}
    </div>
  );
}

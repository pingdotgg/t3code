import { Check, Copy } from "lucide";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { Button } from "./ui/button";

export function CommandBlock({
  command,
  className,
  prominent = false,
  compact = false,
}: {
  readonly command: string;
  readonly className?: string;
  readonly prominent?: boolean;
  readonly compact?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "command",
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-control surface-well font-mono",
        compact
          ? "h-8 gap-2 pr-1.5 pl-2.5 text-caption"
          : prominent
            ? "px-4 py-3.5 text-prompt"
            : "px-3 py-2.5 text-body",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        {compact ? null : <span className="mr-2 text-muted-foreground">$</span>}
        {command}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
      </Button>
    </div>
  );
}

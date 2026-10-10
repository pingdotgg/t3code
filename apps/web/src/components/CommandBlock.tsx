import { Check, Copy } from "lucide";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { Button } from "./ui/button";

/** A shell command to copy and run elsewhere, such as on the environment's host. */
export function CommandBlock({
  command,
  className,
  prominent = false,
}: {
  readonly command: string;
  readonly className?: string;
  readonly prominent?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "command",
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 font-mono",
        prominent ? "px-4 py-3.5 text-base" : "px-3 py-2.5 text-sm",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        <span className="mr-2 text-muted-foreground">$</span>
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

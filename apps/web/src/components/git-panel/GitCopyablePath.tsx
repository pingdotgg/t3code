import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "~/lib/utils";

interface GitCopyablePathProps {
  path: string;
  className?: string;
}

export function GitCopyablePath({ path, className }: GitCopyablePathProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [path]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "group -mx-1.5 flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-accent/50",
        className,
      )}
      title="Click to copy path"
    >
      <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0 text-success-foreground" />
      ) : (
        <CopyIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

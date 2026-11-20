import { Copy } from "lucide-react";
import { useState } from "react";

import { Tooltip } from "../../ui/Tooltip";

const COPIED_MS = 1_500;

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border border-line bg-bg py-0.5 pr-0.5 pl-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{command}</code>
      <Tooltip text={copied ? "Copied" : "Copy command"} align="end">
        <button
          type="button"
          aria-label="Copy update command"
          onClick={copy}
          className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <Copy className="size-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

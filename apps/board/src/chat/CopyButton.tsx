import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Tooltip } from "../ui/Tooltip";

const SETTLE_MS = 1_200;

/** A small icon button that copies what `read` returns when it is pressed, and says for a moment that it did. */
export function CopyButton({ read, label }: { read: () => string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const settle = (next: "copied" | "failed") => {
    setState(next);
    setTimeout(() => setState("idle"), SETTLE_MS);
  };
  return (
    <Tooltip
      text={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      align="end"
    >
      <button
        type="button"
        aria-label={label}
        onClick={() =>
          void navigator.clipboard.writeText(read()).then(
            () => settle("copied"),
            () => settle("failed"),
          )
        }
        className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
      >
        {state === "copied" ? (
          <Check className="size-3.5 text-focus" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </Tooltip>
  );
}

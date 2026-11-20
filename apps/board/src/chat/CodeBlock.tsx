import { WrapText } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Tooltip } from "../ui/Tooltip";
import { CodeBody } from "./CodeBody";
import { CopyButton } from "./CopyButton";

/** A fenced block: a header with the language or file name, the colored code, and its actions. */
export function CodeBlock({
  code,
  language,
  title,
  streaming,
  toolbar,
  canWrap = true,
  children,
}: {
  code: string;
  language: string;
  title: string | null;
  streaming: boolean;
  /** Buttons ahead of wrap and copy. */
  toolbar?: ReactNode;
  canWrap?: boolean;
  /** Shown instead of the colored code, such as a diagram of the block. */
  children?: ReactNode;
}) {
  const [wrapped, setWrapped] = useState(true);
  return (
    <div
      dir="ltr"
      data-testid="code-block"
      data-language={language}
      data-wrap={wrapped}
      className="my-2.5 overflow-hidden rounded-lg border border-line bg-bg text-start"
    >
      <div className="flex items-center justify-between gap-2 pt-1.5 pr-1.5 pl-3 text-[11px] text-muted select-none">
        <span className="min-w-0 truncate font-mono">{title ?? language}</span>
        <span role="toolbar" aria-label="Code block actions" className="flex items-center gap-0.5">
          {toolbar}
          {canWrap && (
            <Tooltip text={wrapped ? "Disable line wrap" : "Wrap lines"} align="end">
              <button
                type="button"
                aria-label={wrapped ? "Disable line wrap" : "Wrap lines"}
                aria-pressed={wrapped}
                onClick={() => setWrapped(!wrapped)}
                className={`grid size-6 place-items-center rounded-md hover:bg-hover hover:text-fg ${wrapped ? "bg-hover text-fg" : ""}`}
              >
                <WrapText className="size-3.5" aria-hidden />
              </button>
            </Tooltip>
          )}
          <CopyButton
            read={() => (code.endsWith("\n") ? code.slice(0, -1) : code)}
            label="Copy code"
          />
        </span>
      </div>
      {children ?? <CodeBody code={code} language={language} streaming={streaming} />}
    </div>
  );
}

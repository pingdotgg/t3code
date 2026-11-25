import { approvalTextParts } from "@t3tools/client-runtime/state/thread-requests";
import { T } from "gt-react";
import { useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * What an approval asks to run, as it will run: characters a screen would not draw are shown by
 * name, and a note says when the text runs past the box.
 */
export function ApprovalText({
  text,
  label,
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [clipped, setClipped] = useState(false);
  const watch = (box: HTMLElement | null) => {
    if (!box) return;
    const measure = () => setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    return observeResize(box, measure);
  };
  return (
    <>
      <code
        ref={watch}
        aria-label={label}
        className={cn(
          "block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          className,
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approvalTextParts(text).map((part, index) =>
          part.named ? (
            // oxlint-disable-next-line react/no-array-index-key -- parts never reorder and two may read alike
            <span key={index} className="rounded-xs bg-warning-surface text-warning-foreground">
              {part.text}
            </span>
          ) : (
            part.text
          ),
        )}
      </code>
      {clipped ? (
        <span className="block font-sans text-xs text-warning-foreground">
          <T>Scroll to read all of it.</T>
        </span>
      ) : null}
    </>
  );
}

import { approvalTextParts } from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * What an approval asks to run, as it will run: characters a screen would not draw are shown by
 * name, and a note says when the text runs past the box or is too long to show in full.
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
  const gt = useGT();
  const [clipped, setClipped] = useState(false);
  const { parts, shownLength, length } = approvalTextParts(text);
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
        data-approval-detail={shownLength < length ? "cut" : "complete"}
        tabIndex={0}
      >
        {parts.map((part, index) =>
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
      {shownLength < length ? (
        <span className="block font-sans text-xs text-warning-foreground">
          {gt(
            "This text is too long to show in full. Above are the first {shown} of its {total} characters.",
            { shown: shownLength.toLocaleString(), total: length.toLocaleString() },
          )}
        </span>
      ) : clipped ? (
        <span className="block font-sans text-xs text-warning-foreground">
          <T>Scroll to read all of it.</T>
        </span>
      ) : null}
    </>
  );
}

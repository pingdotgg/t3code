import {
  type ApprovalTextPart,
  approvalTextParts,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * What an approval asks to run, as it will run: characters a screen would not draw are shown by
 * name, and a note says when the text runs past its box. Text too long to show in full is shown
 * as its beginning and its end, with a note between them of how much is left out.
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
  const [endClipped, setEndClipped] = useState(false);
  const { parts, tail, hiddenLength } = approvalTextParts(text);
  const cut = hiddenLength > 0;
  return (
    <>
      <ApprovalTextBox
        parts={parts}
        label={label}
        className={className}
        detail={cut ? "cut" : "complete"}
        onClipped={setClipped}
      />
      {cut ? (
        <>
          <span className="block font-sans text-caption text-warning-foreground">
            {gt(
              "{count, plural, one {… {hidden} character in the middle is not shown.} other {… {hidden} characters in the middle are not shown.}} The text ends with:",
              { count: hiddenLength, hidden: hiddenLength.toLocaleString() },
            )}
          </span>
          <ApprovalTextBox
            parts={tail}
            className={className}
            detail="end"
            fromEnd
            onClipped={setEndClipped}
          />
          {clipped || endClipped ? (
            <span className="block font-sans text-caption text-warning-foreground">
              <T>Scroll each part to read all of it.</T>
            </span>
          ) : null}
        </>
      ) : clipped ? (
        <span className="block font-sans text-caption text-warning-foreground">
          <T>Scroll to read all of it.</T>
        </span>
      ) : null}
    </>
  );
}

function ApprovalTextBox({
  parts,
  label,
  className,
  detail,
  fromEnd = false,
  onClipped,
}: {
  parts: ReadonlyArray<ApprovalTextPart>;
  label?: string | undefined;
  className?: string | undefined;
  detail: "complete" | "cut" | "end";
  /** Opens scrolled to its last line: the end of the text is what this box is for. */
  fromEnd?: boolean;
  onClipped: (clipped: boolean) => void;
}) {
  const watch = (box: HTMLElement | null) => {
    if (!box) return;
    if (fromEnd) box.scrollTop = box.scrollHeight;
    const measure = () => onClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    return observeResize(box, measure);
  };
  return (
    <code
      ref={watch}
      aria-label={label}
      className={cn(
        "block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-caption leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        className,
      )}
      data-approval-detail={detail}
      tabIndex={0}
    >
      {parts.map((part, index) =>
        part.named ? (
          // oxlint-disable-next-line react/no-array-index-key -- parts never reorder and two may read alike
          <span key={index} className="rounded-kbd bg-warning-surface text-warning-foreground">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </code>
  );
}

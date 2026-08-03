/**
 * `name` + its directory, on one line, with the directory truncated from the
 * LEFT.
 *
 * fork: f4 redesign (audit §8 / M21) — every path label in the panel used to
 * truncate from the right, so
 * `apps/web/src/components/sourceControl/ChangeRow.tsx` in a 360px panel read
 * `ChangeRow.tsx apps/web/src/comp…`: the tail of the directory — the only part
 * that tells two `index.ts`s apart — was exactly what got cut.
 *
 * The mechanism: the clipping box is `direction: rtl` so the ellipsis lands at
 * the start, and the text itself is wrapped in a `<bdi dir="ltr">` so the bidi
 * algorithm keeps the path in reading order inside it. Both halves are needed —
 * rtl alone reorders the leading/trailing slashes.
 *
 * fork: f4 source-control panel
 */
import { cn } from "~/lib/utils";

export function PathLabel(props: {
  readonly name: string;
  readonly dir: string;
  readonly className?: string;
  /** Rendered muted and one step down, as the row's secondary slot. */
  readonly dirClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", props.className)}>
      <span className="min-w-0 shrink-[2] truncate text-foreground">{props.name}</span>
      {props.dir ? (
        <span
          className={cn(
            "min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground text-xs",
            props.dirClassName,
          )}
          // The clipping box runs right-to-left so the ellipsis is at the head.
          dir="rtl"
          style={{ textAlign: "left" }}
        >
          <bdi dir="ltr">{props.dir}</bdi>
        </span>
      ) : null}
    </span>
  );
}

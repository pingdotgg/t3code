import type { DuoPose } from "@t3tools/client-runtime/device/duo-control";
import type { IconNode } from "~/icons/connIcon";
import {
  foldableBookGlyph24,
  foldableClosedGlyph24,
  foldableLaptopGlyph24,
  foldableOpenGlyph24,
  foldableTentGlyph24,
} from "~/icons/glyphs.generated";
import { cn } from "~/lib/utils";

// Drawn at size-7, so these use the set's 24px glyphs. Fold poses turn with the phone.
const GLYPH_BY_POSE: Record<DuoPose, IconNode> = {
  closed: foldableClosedGlyph24,
  open: foldableOpenGlyph24,
  book: foldableBookGlyph24,
  laptop: foldableLaptopGlyph24,
  tent: foldableTentGlyph24,
};

export function DeviceDuoGlyph({ pose, rotated = false }: { pose: DuoPose; rotated?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-7 shrink-0", rotated && "rotate-90")}
      aria-hidden
    >
      {GLYPH_BY_POSE[pose].map(([Tag, attrs], index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a glyph's elements never reorder
        <Tag key={index} {...attrs} />
      ))}
    </svg>
  );
}

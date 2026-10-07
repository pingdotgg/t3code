import type { DuoPose } from "@t3tools/client-runtime/device/duo-control";
import { cn } from "~/lib/utils";

// Fold outlines follow Simulator's Duo toolbar; the rounded stance contours are
// ported from SimulatorFoldingPoseGlyph's SwiftUI paths.
const stancePaths = {
  laptop:
    "M2.7351 12.9857 L15.8128 11.4159 L14.4114 3.3787 C14.1943 2.134 13.1275 1.2319 12.0283 1.3639 L2.9308 2.4559 C1.8317 2.5879 1.1167 3.7038 1.3337 4.9485 L2.7351 12.9857 Z M2.7351 12.9857 L15.8128 11.4159 L19.9103 12.8914 C20.5449 13.1199 20.1683 13.4121 19.0692 13.5441 L9.9717 14.6361 C8.8725 14.7681 7.4672 14.6898 6.8326 14.4612 L2.7351 12.9857 Z",
  tent: "M3.2522 2.7267 L18.7478 1.4816 L16.696 9.7017 C16.3782 10.9748 15.0649 12.0915 13.7626 12.1962 L2.983 13.0623 C1.6807 13.167 0.8826 12.2199 1.2004 10.9468 L3.2522 2.7267 Z M3.2522 2.7267 L18.7478 1.4816 L20.7996 10.6909 C21.1174 12.1172 20.3193 13.3581 19.017 13.4628 L8.2374 14.3289 C6.9351 14.4336 5.6218 13.3623 5.304 11.936 L3.2522 2.7267 Z",
} as const;

/**
 * Fold glyphs draw the physical device held as a vertical phone: it opens like a book into a
 * landscape tablet. `rotated` turns the whole device a quarter clockwise for a horizontal phone,
 * camera and home indicator included, as Simulator does.
 */
export function DeviceDuoGlyph({ pose, rotated = false }: { pose: DuoPose; rotated?: boolean }) {
  const stance = pose === "laptop" || pose === "tent";
  return (
    <svg
      viewBox={stance ? "0 0 22 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={stance ? 1.25 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-7 shrink-0", rotated && "rotate-90")}
      aria-hidden
    >
      {stance ? <path d={stancePaths[pose]} /> : null}
      {pose === "closed" ? (
        <>
          <rect x="5.8" y="3" width="12.4" height="18" rx="2.2" />
          <circle cx="15.4" cy="5.7" r=".6" fill="currentColor" stroke="none" />
          <path d="M10.6 18.2h2.8" />
        </>
      ) : null}
      {pose === "book" ? (
        <path d="M5.2 5.6Q12 7.6 18.8 5.6Q20.5 5.1 20.5 6.9V17.1Q20.5 18.9 18.8 18.4Q12 16.4 5.2 18.4Q3.5 18.9 3.5 17.1V6.9Q3.5 5.1 5.2 5.6Z" />
      ) : null}
      {pose === "open" ? (
        <>
          <rect x="2.5" y="5" width="19" height="14" rx="2.4" />
          <path d="M10.5 16.3h3" />
        </>
      ) : null}
    </svg>
  );
}

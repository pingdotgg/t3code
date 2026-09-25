import type { DuoPose } from "@t3tools/client-runtime/device/duo-control";

// Bitrig 0.25's toolbar glyphs. The fold outlines follow the native toolbar;
// the rounded stance contours are ported from SimulatorFoldingPoseGlyph's SwiftUI paths.
const stancePaths = {
  laptop:
    "M2.7351 12.9857 L15.8128 11.4159 L14.4114 3.3787 C14.1943 2.134 13.1275 1.2319 12.0283 1.3639 L2.9308 2.4559 C1.8317 2.5879 1.1167 3.7038 1.3337 4.9485 L2.7351 12.9857 Z M2.7351 12.9857 L15.8128 11.4159 L19.9103 12.8914 C20.5449 13.1199 20.1683 13.4121 19.0692 13.5441 L9.9717 14.6361 C8.8725 14.7681 7.4672 14.6898 6.8326 14.4612 L2.7351 12.9857 Z",
  tent: "M3.2522 2.7267 L18.7478 1.4816 L16.696 9.7017 C16.3782 10.9748 15.0649 12.0915 13.7626 12.1962 L2.983 13.0623 C1.6807 13.167 0.8826 12.2199 1.2004 10.9468 L3.2522 2.7267 Z M3.2522 2.7267 L18.7478 1.4816 L20.7996 10.6909 C21.1174 12.1172 20.3193 13.3581 19.017 13.4628 L8.2374 14.3289 C6.9351 14.4336 5.6218 13.3623 5.304 11.936 L3.2522 2.7267 Z",
} as const;

export function DeviceDuoGlyph({ pose }: { pose: DuoPose }) {
  const stance = pose === "laptop" || pose === "tent";
  return (
    <svg
      viewBox={stance ? "0 0 22 16" : "0 0 24 32"}
      fill="none"
      stroke="currentColor"
      strokeWidth={stance ? 1.25 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-7 shrink-0"
      aria-hidden
    >
      {stance ? <path d={stancePaths[pose]} /> : null}
      {pose === "closed" ? (
        <>
          <rect x="2" y="9" width="20" height="13" rx="2.2" />
          <path d="M19.3 12.5v6" />
          <circle cx="5" cy="12" r=".5" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {pose === "book" ? (
        <path d="M4.2 6.5h15.6c1 0 1.6.8 1.2 1.7L17.7 16l3.3 7.8c.4.9-.2 1.7-1.2 1.7H4.2c-1 0-1.6-.8-1.2-1.7L6.3 16 3 8.2c-.4-.9.2-1.7 1.2-1.7Z" />
      ) : null}
      {pose === "open" ? (
        <>
          <rect x="2" y="2" width="20" height="28" rx="2.4" />
          <path d="M10 27h4" />
        </>
      ) : null}
    </svg>
  );
}

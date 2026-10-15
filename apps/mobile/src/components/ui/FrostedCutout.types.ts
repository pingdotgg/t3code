export interface FrostedCutoutProps {
  /** Distance from the top edge to the clear hole; the hole is centered horizontally. */
  readonly cutoutTop: number;
  readonly cutoutWidth: number;
  readonly cutoutHeight: number;
  readonly cutoutRadius: number;
  readonly appearance: "light" | "dark";
}

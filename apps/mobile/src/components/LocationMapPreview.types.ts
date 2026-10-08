import type { SharedLocation } from "@t3tools/contracts";

export interface LocationMapPreviewProps {
  readonly location: SharedLocation;
  readonly appearance: "light" | "dark";
}

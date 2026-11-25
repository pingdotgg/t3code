import { FullWindowOverlay } from "react-native-screens";

import type { WindowCoverProps } from "./WindowCover.types";

export function WindowCover(props: WindowCoverProps) {
  if (!props.visible && !props.obscured) return null;
  return <FullWindowOverlay>{props.children}</FullWindowOverlay>;
}

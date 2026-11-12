import type { IconProps } from "@tabler/icons-react-native/types";
import { forwardRef } from "react";
import Svg, { Path } from "react-native-svg";

// Match the paired chevrons used by the desktop diff controls.
export const DiffCollapseIcon = forwardRef<Svg, IconProps>(function DiffCollapseIcon(
  { size = 24, color = "currentColor", strokeWidth = 2, ...props },
  ref,
) {
  return (
    <Svg
      {...props}
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="m7 20 5-5 5 5" />
      <Path d="m7 4 5 5 5-5" />
    </Svg>
  );
});

export const DiffExpandIcon = forwardRef<Svg, IconProps>(function DiffExpandIcon(
  { size = 24, color = "currentColor", strokeWidth = 2, ...props },
  ref,
) {
  return (
    <Svg
      {...props}
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="m7 15 5 5 5-5" />
      <Path d="m7 9 5-5 5 5" />
    </Svg>
  );
});

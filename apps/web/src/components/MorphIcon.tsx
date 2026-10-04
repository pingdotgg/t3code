import { MorphIcon as BaseMorphIcon, type MorphIconProps } from "morphicons/react";

/** Renders `lucide` icon data and morphs between shapes when `icon` changes. */
export function MorphIcon({ reducedMotion = "user", ...props }: MorphIconProps) {
  return <BaseMorphIcon reducedMotion={reducedMotion} {...props} />;
}

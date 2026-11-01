import { MorphIcon as BaseMorphIcon, type MorphIconProps } from "morphicons/react";

export function MorphIcon({ reducedMotion = "user", ...props }: MorphIconProps) {
  return <BaseMorphIcon reducedMotion={reducedMotion} {...props} />;
}

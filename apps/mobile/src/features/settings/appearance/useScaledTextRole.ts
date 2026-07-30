import { useCSSVariable } from "uniwind";

import { MOBILE_TYPOGRAPHY } from "../../../lib/typography";

const TEXT_ROLE_VARIABLES = {
  micro: "--text-3xs",
  caption: "--text-2xs",
  label: "--text-xs",
  footnote: "--text-sm",
  body: "--text-base",
  headline: "--text-lg",
  title: "--text-xl",
  largeTitle: "--text-2xl",
  display: "--text-3xl",
} as const satisfies Record<keyof typeof MOBILE_TYPOGRAPHY, string>;

export interface ScaledTextRole {
  readonly fontSize: number;
  readonly lineHeight: number;
}

/**
 * Reads a typography role's current size from the Uniwind `--text-*` CSS
 * variables (scaled at runtime with the base font size). Use for style-prop
 * consumers that can't express their size as a `text-*` className. Reactive:
 * re-renders when the appearance provider re-injects the variables.
 */
export function useScaledTextRole(role: keyof typeof MOBILE_TYPOGRAPHY): ScaledTextRole {
  const variable = TEXT_ROLE_VARIABLES[role];
  const [fontSize, lineHeight] = useCSSVariable([variable, `${variable}--line-height`]);

  return {
    fontSize: typeof fontSize === "number" ? fontSize : MOBILE_TYPOGRAPHY[role].fontSize,
    lineHeight: typeof lineHeight === "number" ? lineHeight : MOBILE_TYPOGRAPHY[role].lineHeight,
  };
}

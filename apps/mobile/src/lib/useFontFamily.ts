import { useCSSVariable } from "uniwind";

const FONT_FAMILY_VARIABLES = {
  regular: "--font-sans",
  medium: "--font-medium",
  bold: "--font-bold",
} as const;

/**
 * Resolves a font family for APIs that require a style object or native prop.
 * Prefer Uniwind font classes when the target component accepts `className`.
 */
export function useFontFamily(weight: keyof typeof FONT_FAMILY_VARIABLES): string {
  return useCSSVariable(FONT_FAMILY_VARIABLES[weight]) as string;
}

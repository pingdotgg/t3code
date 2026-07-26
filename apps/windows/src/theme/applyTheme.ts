/**
 * Publishes the TypeScript design tokens onto the document as CSS custom
 * properties, so `theme.css` never re-derives a number that `palette.ts`,
 * `motion.ts`, `typography.ts` or `glass.ts` already owns.
 *
 * The macOS app gets this for free — SwiftUI views read the enums directly.
 * The web port needs an explicit publish step, and it has to re-run when the
 * reduce-motion preference or the translucency slider changes, matching the
 * macOS guarantee that a settings change applies from the next state change
 * onward.
 */

import { layerStack } from "./glass.ts";
import { motionCssVariables, motionProfile } from "./motion.ts";
import {
  accent,
  clay,
  cssColor,
  forest,
  lavender,
  lichen,
  meadow,
  sky,
  userBubbleFill,
  userBubbleStrokeAlpha,
} from "./palette.ts";
import { typographyCssVariables } from "./typography.ts";

function paletteCssVariables(): Record<string, string> {
  return {
    "--color-accent": cssColor(accent),
    "--color-forest": cssColor(forest),
    "--color-meadow": cssColor(meadow),
    "--color-sky": cssColor(sky),
    "--color-clay": cssColor(clay),
    "--color-lichen": cssColor(lichen),
    "--color-lavender": cssColor(lavender),
    "--color-user-bubble": cssColor(userBubbleFill),
    "--color-user-bubble-stroke": cssColor(accent, userBubbleStrokeAlpha),
  };
}

export interface ThemeInput {
  readonly translucency: number;
  readonly reduceMotion: boolean;
}

/** Every variable the stylesheet reads, for a given app state. */
export function themeCssVariables(input: ThemeInput): Record<string, string> {
  const stack = layerStack(input.translucency, "dark");
  return {
    ...paletteCssVariables(),
    ...typographyCssVariables(),
    ...motionCssVariables(motionProfile(input.reduceMotion)),
    "--plate-alpha": String(stack.plateAlpha),
    "--wash-alpha": String(stack.washAlpha),
    "--photo-opacity": String(stack.photoOpacity),
  };
}

/** Applies the variables to an element (the document root in the app). */
export function applyTheme(element: HTMLElement, input: ThemeInput): void {
  for (const [name, value] of Object.entries(themeCssVariables(input))) {
    element.style.setProperty(name, value);
  }
}

/**
 * Per-environment accent colors.
 *
 * Every environment indicator in the app (the sidebar cloud/server glyphs, the
 * "Run on" selector, the project remote badge) is otherwise identical across
 * environments, so a user running threads on several machines cannot tell at a
 * glance *which* one a thread belongs to without hovering. Assigning a color
 * per environment differentiates those existing glyphs without adding any
 * text, which matters because sidebar rows have no horizontal room to spare.
 *
 * The mapping lives in client settings rather than server settings: it is a
 * property of how *this* client distinguishes its environments, it must stay
 * readable while an environment is disconnected, and no single backend should
 * dictate it to the others.
 *
 * @module environmentAccentColors
 */
import type { ClientSettings, EnvironmentId } from "@t3tools/contracts";
import { useCallback, type CSSProperties } from "react";

import { normalizeAccentColor } from "./accentColors";
import { useClientSettings, useUpdateClientSettingsWith } from "./hooks/useSettings";

export type EnvironmentAccentColors = ClientSettings["environmentAccentColors"];

/**
 * Read one environment's color, dropping anything that is not a usable hex
 * value so callers can pass the result straight to CSS.
 */
export function resolveEnvironmentAccentColor(
  accentColors: EnvironmentAccentColors | undefined,
  environmentId: EnvironmentId | null | undefined,
): string | undefined {
  if (environmentId === null || environmentId === undefined) return undefined;
  return normalizeAccentColor(accentColors?.[environmentId]);
}

/**
 * Resolve the shared color for a set of environments: a mixed or uncolored set
 * has no single color to show, so indicators that stand for several
 * environments at once (a grouped project's remote badge) stay neutral.
 */
export function resolveSharedEnvironmentAccentColor(
  accentColors: EnvironmentAccentColors | undefined,
  environmentIds: readonly EnvironmentId[],
): string | undefined {
  const colors = new Set(
    environmentIds.map((environmentId) =>
      resolveEnvironmentAccentColor(accentColors, environmentId),
    ),
  );
  const [color] = [...colors];
  return colors.size === 1 ? color : undefined;
}

/**
 * Set or clear one environment's color, leaving the rest of the map untouched.
 * Clearing removes the key so the settings blob does not accumulate empties.
 */
export function applyEnvironmentAccentColor(
  accentColors: EnvironmentAccentColors | undefined,
  environmentId: EnvironmentId,
  color: string | undefined,
): Record<EnvironmentId, string> {
  const next: Record<EnvironmentId, string> = { ...accentColors };
  const normalized = normalizeAccentColor(color);
  if (normalized === undefined) {
    delete next[environmentId];
  } else {
    next[environmentId] = normalized;
  }
  return next;
}

/**
 * Inline style that tints an environment glyph, or `undefined` to leave the
 * glyph's default muted treatment in place. Returned as an inline style rather
 * than a class so it can override the utility class already on the element;
 * icons drawn with a stroke need `stroke` instead of `color`.
 */
export function environmentAccentStyle(
  accentColor: string | undefined,
  property: "color" | "stroke" = "color",
): CSSProperties | undefined {
  if (accentColor === undefined) return undefined;
  return property === "stroke" ? { stroke: accentColor } : { color: accentColor };
}

export function useEnvironmentAccentColors(): EnvironmentAccentColors {
  return useClientSettings((settings) => settings.environmentAccentColors);
}

export function useEnvironmentAccentColor(
  environmentId: EnvironmentId | null | undefined,
): string | undefined {
  const accentColors = useEnvironmentAccentColors();
  return resolveEnvironmentAccentColor(accentColors, environmentId);
}

export function useSetEnvironmentAccentColor(): (
  environmentId: EnvironmentId,
  color: string | undefined,
) => void {
  // Derived from the settings in effect at call time, not at render time: the
  // picker commits on a delay, so two environments recolored in quick
  // succession would otherwise both start from the same stale map and the
  // second write would drop the first environment's color.
  const updateSettings = useUpdateClientSettingsWith();
  return useCallback(
    (environmentId, color) => {
      updateSettings((settings) => ({
        environmentAccentColors: applyEnvironmentAccentColor(
          settings.environmentAccentColors,
          environmentId,
          color,
        ),
      }));
    },
    [updateSettings],
  );
}

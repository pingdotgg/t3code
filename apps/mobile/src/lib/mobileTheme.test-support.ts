import * as NodeFS from "node:fs";

import {
  createMobileThemeVariables,
  type MobileThemeVariable,
  type MobileThemeAppearance,
  type MobileThemeVariables,
} from "./mobileTheme";

import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";

const MOBILE_THEME_VARIABLE_NAMES = Object.keys(
  createMobileThemeVariables(T3_CHAT_THEME.colors, "light"),
) as ReadonlyArray<MobileThemeVariable>;

export function readDefaultMobileThemeVariables(
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  return readGeneratedMobileThemeVariables(appearance);
}

export function readGeneratedMobileThemeVariables(themeName: string): MobileThemeVariables {
  const stylesheet = NodeFS.readFileSync(
    new URL("../../generated-uniwind-themes.css", import.meta.url),
    "utf8",
  );
  const variant = new RegExp(`@variant ${themeName} \\{([\\s\\S]*?)\\n    \\}`, "u").exec(
    stylesheet,
  )?.[1];
  if (variant === undefined) throw new Error(`Missing generated ${themeName} theme.`);

  return Object.fromEntries(
    Array.from(variant.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/gu), ([, name, value]) => [
      name,
      (value ?? "").trim(),
    ]).filter(([name]) =>
      MOBILE_THEME_VARIABLE_NAMES.includes(name as (typeof MOBILE_THEME_VARIABLE_NAMES)[number]),
    ),
  ) as MobileThemeVariables;
}

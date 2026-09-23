import * as NodeFS from "node:fs";

import {
  MOBILE_THEME_VARIABLE_NAMES,
  type MobileThemeAppearance,
  type MobileThemeVariables,
} from "./mobileTheme";

export function readDefaultMobileThemeVariables(
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  const stylesheet = NodeFS.readFileSync(
    new URL("../../generated-uniwind-themes.css", import.meta.url),
    "utf8",
  );
  const variant = new RegExp(`@variant ${appearance} \\{([\\s\\S]*?)\\n    \\}`, "u").exec(
    stylesheet,
  )?.[1];
  if (variant === undefined) throw new Error(`Missing generated default ${appearance} theme.`);

  return Object.fromEntries(
    Array.from(variant.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/gu), ([, name, value]) => [
      name,
      (value ?? "").trim(),
    ]).filter(([name]) =>
      MOBILE_THEME_VARIABLE_NAMES.includes(name as (typeof MOBILE_THEME_VARIABLE_NAMES)[number]),
    ),
  ) as MobileThemeVariables;
}

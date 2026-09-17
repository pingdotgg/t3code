import { assert, describe, expect } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const guardedMobileFile = createOxlintRuleHarness("t3code/no-mobile-uniwind-theme-escape-hatches", {
  filename: "apps/mobile/src/features/settings/NewThemeSurface.tsx",
});
const reviewedInteropFile = createOxlintRuleHarness(
  "t3code/no-mobile-uniwind-theme-escape-hatches",
  {
    filename: "apps/mobile/src/features/home/HomeHeader.tsx",
    ruleOptions: [{ allowUniwindTheme: true }],
  },
);

describe("t3code/no-mobile-uniwind-theme-escape-hatches", () => {
  guardedMobileFile.valid(
    "allows semantic mobile theme classes",
    `const surface = <View className="bg-surface text-foreground" />;`,
  );

  guardedMobileFile.valid(
    "allows unrelated functions with legacy hook names",
    `
      const useCSSVariable = () => "local value";
      const useThemeColor = () => "local color";

      export const values = [useCSSVariable(), useThemeColor()];
    `,
  );

  guardedMobileFile.valid(
    "allows unrelated imports with legacy hook names",
    `
      import { useThemeColor } from "./unrelated-library";

      export const foreground = useThemeColor();
    `,
  );

  guardedMobileFile.valid(
    "allows erased type-only theme imports",
    `
      import type { useCSSVariable } from "uniwind";
      import { type useCSSVariable as CSSVariableHook } from "uniwind";
      import type { useThemeColor } from "../../../hooks/useThemeColor";
      import type { useUniwindTheme } from "../../../lib/useUniwindTheme";

      export type ThemeHooks = [
        typeof useCSSVariable,
        typeof CSSVariableHook,
        typeof useThemeColor,
        typeof useUniwindTheme,
      ];
    `,
  );

  guardedMobileFile.valid(
    "allows appearance words in ordinary copy",
    `
      const message = "Set dark mode manually";
      const detail = "For dark: high contrast mode is available";
      const label = <Text accessibilityLabel="Light theme">Theme</Text>;
    `,
  );

  guardedMobileFile.valid(
    "does not conflate shadowed Uniwind namespaces",
    `
      import * as Uniwind from "uniwind";

      export function readDirect(Uniwind: { useCSSVariable: () => string }) {
        return Uniwind.useCSSVariable();
      }

      export function readDestructured(Uniwind: { useCSSVariable: () => string }) {
        const { useCSSVariable } = Uniwind;
        return useCSSVariable();
      }
    `,
  );

  reviewedInteropFile.valid(
    "allows reviewed native interop boundaries",
    `
      import { useUniwindTheme } from "../../lib/useUniwindTheme";

      export const foreground = useUniwindTheme().colors.foreground;
    `,
  );

  reviewedInteropFile.invalid(
    "still reports appearance variants in reviewed interop boundaries",
    `const surface = <View className="bg-white dark:bg-black" />;`,
  );

  guardedMobileFile.invalid(
    "reports new React theme subscriptions",
    `
      import { useCSSVariable } from "uniwind";

      export const foreground = useCSSVariable("--color-foreground");
    `,
    (output) => {
      assert.match(output, /semantic className/);
    },
  );

  guardedMobileFile.invalid(
    "reports the retired theme color hook",
    `
      import { useThemeColor } from "../../../hooks/useThemeColor";

      export const foreground = useThemeColor({}, "foreground");
    `,
    (output) => {
      assert.match(output, /replaced by semantic Uniwind classes/);
    },
  );

  guardedMobileFile.invalid(
    "reports guarded hooks imported with TypeScript extensions",
    `
      import { useThemeColor } from "../../../hooks/useThemeColor.ts";
      import { useUniwindTheme } from "../../../lib/useUniwindTheme.ts";

      export const foreground = [
        useThemeColor({}, "foreground"),
        useUniwindTheme().colors.foreground,
      ];
    `,
    (output) => {
      assert.match(output, /replaced by semantic Uniwind classes/);
      assert.match(output, /native\/third-party interop boundary/);
    },
  );

  guardedMobileFile.invalid(
    "reports unreviewed native interop subscriptions",
    `
      import { useUniwindTheme } from "../../../lib/useUniwindTheme";

      export const foreground = useUniwindTheme().colors.foreground;
    `,
    (output) => {
      assert.match(output, /native\/third-party interop boundary/);
    },
  );

  guardedMobileFile.invalid(
    "reports appearance variants in string literals",
    `const surface = <View className="bg-white dark:bg-black" />;`,
    (output) => {
      assert.match(output, /registered custom themes/);
    },
  );

  guardedMobileFile.invalid(
    "reports appearance variants in template literals",
    "const className = `bg-black light:bg-white`;",
  );

  guardedMobileFile.invalid(
    "reports escaped appearance variants in template literals",
    "const className = `dark\\u003abg-black`;",
  );

  guardedMobileFile.invalid(
    "reports appearance variants through nested class-map indirection",
    `
      const styles = {
        variants: { root: "bg-white dark:bg-black" },
      };

      const root = styles.variants.root;
      export const surface = <View className={root} />;
    `,
    (output) => {
      expect(output.match(/registered custom themes/g)).toHaveLength(1);
    },
  );

  guardedMobileFile.invalid(
    "reports appearance variants passed to class builders",
    `const surface = cn("bg-white", enabled && "dark:bg-black");`,
  );

  guardedMobileFile.invalid(
    "reports negative and important appearance variants",
    `const className = "dark:-mt-2 light:!bg-white";`,
  );

  guardedMobileFile.invalid(
    "reports namespace CSS variable subscriptions",
    `
      import * as Uniwind from "uniwind";

      export const foreground = Uniwind.useCSSVariable("--color-foreground");
    `,
  );

  guardedMobileFile.invalid(
    "reports destructured namespace CSS variable subscriptions",
    `
      import * as Uniwind from "uniwind";

      const { useCSSVariable: resolveVariable } = Uniwind;
      export const foreground = resolveVariable("--color-foreground");
    `,
  );

  guardedMobileFile.invalid(
    "reports aliased namespace CSS variable subscriptions",
    `
      import * as Uniwind from "uniwind";

      const Theme = Uniwind;
      const NestedTheme = Theme;
      export const foreground = NestedTheme.useCSSVariable("--color-foreground");
    `,
  );

  guardedMobileFile.invalid(
    "reports object-rest namespace CSS variable subscriptions",
    `
      import * as Uniwind from "uniwind";

      const { ...Theme } = Uniwind;
      export const foreground = Theme.useCSSVariable("--color-foreground");
    `,
  );

  guardedMobileFile.invalid(
    "reports namespace access to the retired theme hook",
    `
      import * as ThemeColor from "../../../hooks/useThemeColor";

      export const foreground = ThemeColor.useThemeColor({}, "foreground");
    `,
  );

  guardedMobileFile.invalid(
    "reports destructured namespace access to the retired theme hook",
    `
      import * as ThemeColor from "../../../hooks/useThemeColor.ts";

      const { useThemeColor: resolveThemeColor } = ThemeColor;
      export const foreground = resolveThemeColor({}, "foreground");
    `,
  );
});

import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-hookless-use-function", {
  filename: "fixture.tsx",
});

describe("t3code/no-hookless-use-function", () => {
  rule.valid(
    "allows a hook that calls useState",
    `function useCount() { const [count] = useState(0); return count; }`,
  );

  rule.valid(
    "allows a hook that only calls use()",
    `const useTheme = () => { return use(ThemeContext); };`,
  );

  rule.valid(
    "allows a hook that calls a member hook",
    `const useStore = () => React.useContext(StoreContext);`,
  );

  rule.valid("allows a plain function", `function formatLabel(value) { return String(value); }`);

  rule.valid("allows names that only start with use", `function user() { return null; }`);

  rule.invalid(
    "reports a hook-less function declaration",
    `function useFontFamily(weight) { return FONT_FAMILIES[weight]; }`,
  );

  rule.invalid(
    "reports a hook-less arrow returning a closure",
    `const useUpdateSettings = () => (patch) => persist(patch);`,
  );

  rule.invalid(
    "reports a hook-less function expression",
    `const useCompleteOnboarding = function () { return completeOnboarding; };`,
  );

  rule.invalid(
    "reports a hook call that only happens inside a nested callback",
    `function useHandler() { return () => useState(0); }`,
  );
});

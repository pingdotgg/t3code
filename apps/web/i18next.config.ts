import { defineConfig } from "i18next-cli";

// Gate (`i18next-cli extract --ci`, wired into vp run check:changed) enforces en
// completeness only: omitMissingKeys leaves zh-Hans untouched so a missing zh
// key never fails the check — it falls back to en at runtime.
export default defineConfig({
  locales: ["en", "zh-Hans"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    output: "locales/{{language}}/{{namespace}}.json",
    defaultNS: "settings",
    primaryLanguage: "en",
    omitMissingKeys: true,
    // Dynamic keys (translateDynamic(`ns:${...}`)) are invisible to the
    // extractor; pruning would delete their entire namespace.
    removeUnusedKeys: false,
    extractFromComments: false,
  },
  // Test fixtures assert on en copy by design; they are not translatable UI.
  lint: {
    ignore: ["**/*.test.ts", "**/*.test.tsx"],
  },
});

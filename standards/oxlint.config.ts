import type { OxlintConfig } from "vite-plus/lint";

type Rules = NonNullable<OxlintConfig["rules"]>;

const typescriptRules = {
  "typescript/ban-ts-comment": "error",
  "no-array-constructor": "error",
  "typescript/no-duplicate-enum-values": "error",
  "typescript/no-empty-object-type": "error",
  "typescript/no-explicit-any": "error",
  "typescript/no-extra-non-null-assertion": "error",
  "typescript/no-misused-new": "error",
  "typescript/no-namespace": "error",
  "typescript/no-non-null-asserted-optional-chain": "error",
  "typescript/no-require-imports": "error",
  "typescript/no-this-alias": "error",
  "typescript/no-unnecessary-type-constraint": "error",
  "typescript/no-unsafe-declaration-merging": "error",
  "typescript/no-unsafe-function-type": "error",
  "no-unused-expressions": "error",
  "no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
  ],
  "typescript/no-wrapper-object-types": "error",
  "typescript/prefer-as-const": "error",
  "typescript/prefer-namespace-keyword": "error",
  "typescript/triple-slash-reference": "error",
  "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
  "react/no-multi-comp": ["error", { ignoreStateless: false }],
  "import/no-cycle": "error",
} satisfies Rules;

const testFiles = ["**/*.test.{ts,tsx,mts,cts}", "**/*.spec.{ts,tsx,mts,cts}", "**/__tests__/**"];

export default {
  lint: {
    categories: { correctness: "off" },
    plugins: ["eslint", "typescript", "react", "import"],
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/build/**",
      "**/coverage/**",
      "**/generated/**",
      "**/*.d.ts",
      "rules/**",
    ],
    jsPlugins: [
      { name: "anti-slop", specifier: "./rules/anti-slop/index.ts" },
      { name: "project", specifier: "./rules/project/index.mjs" },
    ],
    settings: { react: { version: "19.0.0" } },
    rules: {
      ...typescriptRules,
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "project/no-agent-debug-instrumentation": "error",
      "project/prefer-enum-property-types": [
        "error",
        {
          properties: {
            runtimeMode: {
              types: ["RuntimeMode"],
              hint: "Use RuntimeMode from @t3tools/contracts.",
            },
            interactionMode: {
              types: ["ProviderInteractionMode"],
              hint: "Use ProviderInteractionMode from @t3tools/contracts.",
            },
          },
        },
      ],
      "project/no-process-env-outside-runtime-profile": [
        "error",
        {
          allowPatterns: [
            "/(scripts|electron|standards)/",
            "vite\\.config\\.[cm]?ts$",
            "\\.test\\.[cm]?[jt]sx?$",
          ],
        },
      ],
    },
    overrides: [
      {
        files: ["**/*.{jsx,tsx}"],
        excludeFiles: testFiles,
        rules: {
          "project/no-use-effect": "error",
          "project/no-unbounded-promise-fan-out": "error",
        },
      },
      {
        files: ["**/*.{ts,mts,cts}"],
        excludeFiles: testFiles,
        rules: { "project/no-unbounded-promise-fan-out": "error" },
      },
      {
        files: testFiles,
        rules: {
          "project/no-fixed-sleep": "error",
          "project/no-unsignaled-poll": "error",
          "project/no-shared-worker-state": "error",
        },
      },
    ],
  } satisfies OxlintConfig,
};

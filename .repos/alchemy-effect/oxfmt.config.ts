import { defineConfig, type OxfmtConfig } from "oxfmt";

export default defineConfig({
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  useTabs: false,
  printWidth: 100,
  endOfLine: "lf",
  trailingComma: "all",
  ternaries: true,
  sortPackageJson: true,
  insertFinalNewline: true,
  embeddedLanguageFormatting: "auto",
  sortImports: {
    newlinesBetween: false,
  },
  ignorePatterns: [
    "dist/**",
    "submodules/**",
    "*.min.js",
    "**/lib/**",
    "**/mdx/**",
    "**/*.mdx",
    "**/*.md",
    "**/__snapshots__/**",
    "**/.svelte-kit/**",
    "**/routeTree.gen.ts",
    "**/test-results/**",
    "examples/prisma-tanstack-start/src/prisma/contract.d.ts",
    "examples/prisma-tanstack-start/src/prisma/contract.json",
    "**/fixtures/chart/templates/**",
  ],
} satisfies OxfmtConfig);

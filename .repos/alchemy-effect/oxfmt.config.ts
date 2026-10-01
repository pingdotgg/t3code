import { defineConfig } from "oxfmt";

export default defineConfig({
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  useTabs: false,
  printWidth: 80,
  endOfLine: "lf",
  ternaries: true,
  sortImports: false,
  ignorePatterns: [
    "dist/**",
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
    "**/package.json",
    "./submodules",
    "**/fixtures/chart/templates/**",
  ],
});

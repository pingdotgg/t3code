import { defineConfig } from "vite-plus";

const isWorkspaceRoot = process.cwd() === import.meta.dirname;

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      ".plans",
      "dist",
      "dist-electron",
      "node_modules",
      "bun.lock",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/web/public/mockServiceWorker.js",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      "dist",
      "dist-electron",
      "node_modules",
      "bun.lock",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "react-in-jsx-scope": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
    },
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    projects: isWorkspaceRoot
      ? [
          "packages/contracts",
          "packages/shared",
          "apps/server",
          "apps/web",
          "apps/desktop",
          "scripts",
        ]
      : undefined,
  },
});

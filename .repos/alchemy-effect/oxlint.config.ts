import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["packages/alchemy/test/**", "submodules/**", "examples/**"],
  rules: {
    "no-misused-new": "off",
    "require-yield": "off",
    "no-non-null-asserted-optional-chain": "off",
  },
});

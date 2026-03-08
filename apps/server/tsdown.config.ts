import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) =>
    id.startsWith("@t3tools/") ||
    id.startsWith("@github/copilot") ||
    id.startsWith("vscode-jsonrpc") ||
    id.startsWith("@anthropic-ai/claude-agent-sdk") ||
    id.startsWith("@opencode-ai/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});

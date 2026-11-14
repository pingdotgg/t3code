import path from "node:path";
import { defineConfig } from "vitest/config";

const packageRoot = path.resolve(import.meta.dirname, "..");

const project = (hooks: "stack" | "list") => ({
  extends: true as const,
  test: {
    name: `hooks-${hooks}`,
    sequence: { hooks },
  },
});

export default defineConfig({
  test: {
    root: packageRoot,
    include: ["vitest/**/*.test.ts"],
    projects: [project("stack"), project("list")],
  },
});

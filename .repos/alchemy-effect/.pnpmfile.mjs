import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrap } from "./scripts/bootstrap-distilled.mjs";

export const hooks = {
  updateConfig(config) {
    // pnpm also runs this hook for parallel Turbo tasks. Only bootstrap a
    // missing checkout; leave existing worktrees and their Git config alone.
    if (!existsSync(resolve(import.meta.dirname, "submodules/distilled/.git"))) {
      bootstrap(import.meta.dirname);
    }
    return config;
  },
};

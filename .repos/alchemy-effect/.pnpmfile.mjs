import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrap } from "./scripts/bootstrap-distilled.mjs";

export const hooks = {
  async updateConfig(config) {
    // pnpm also runs this hook for parallel recursive tasks. Only bootstrap a
    // missing checkout; leave existing worktrees and their Git config alone.
    const checkout = resolve(import.meta.dirname, "submodules/distilled/.git");
    if (
      !(await access(checkout).then(
        () => true,
        () => false,
      ))
    ) {
      await bootstrap(import.meta.dirname);
    }
    return config;
  },
};

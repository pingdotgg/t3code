import { expect, it } from "vite-plus/test";

import { scheduledTaskWorktreeBaseRef } from "./scheduledTaskWorktree.ts";

const ref = (name: string, isDefault = false) => ({ name, isDefault });

it("keeps a picked base and otherwise uses the project's default branch", () => {
  expect(scheduledTaskWorktreeBaseRef(" release ", [ref("master", true)])).toBe("release");
  expect(scheduledTaskWorktreeBaseRef("feat\u00a0", [ref("main", true)])).toBe("feat\u00a0");
  expect(scheduledTaskWorktreeBaseRef("\u00a0", [ref("main", true)])).toBe("\u00a0");
  expect(scheduledTaskWorktreeBaseRef("", [ref("feature"), ref("master", true)])).toBe("master");
  expect(scheduledTaskWorktreeBaseRef(" ", [ref("origin/develop", true)])).toBe("origin/develop");
});

it("falls back to main, then master, when no ref is marked default", () => {
  expect(scheduledTaskWorktreeBaseRef("", [ref("feature"), ref("master")])).toBe("master");
  expect(scheduledTaskWorktreeBaseRef("", [ref("origin/master")])).toBe("origin/master");
  expect(scheduledTaskWorktreeBaseRef("", [ref("master"), ref("main")])).toBe("main");
  expect(scheduledTaskWorktreeBaseRef("", [])).toBe("main");
});

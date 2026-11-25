import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { WorktreeSetupStage } from "./worktreeSetup.ts";

const decodeStage = Schema.decodeUnknownSync(WorktreeSetupStage);

it("keeps worktree setup readable when a newer server reports an unknown repository operation", () => {
  const stage = decodeStage({
    id: "checkout",
    status: "running",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: "assets · 2/3",
    repositoryProgress: { active: { name: "assets", operation: "future" }, done: 2, total: 3 },
    tail: [],
  });

  expect(stage).not.toHaveProperty("repositoryProgress");
  expect(stage.detail).toBe("assets · 2/3");
});

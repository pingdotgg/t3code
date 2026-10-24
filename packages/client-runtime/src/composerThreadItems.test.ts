import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerThreadItems } from "./composerThreadItems.ts";

const env = EnvironmentId.make("env-1");
const shell = (id: string, title: string) => ({
  environmentId: env,
  id: ThreadId.make(id),
  title,
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
});

describe("matchComposerThreadItems", () => {
  it("finds a thread by its pasted ID without matching other IDs that share its prefix", () => {
    const pasted =
      "thread:project:6f1c2a4e-8b7d-4d3a-9c5e-1a2b3c4d5e6f:0b9d7c1a-3e5f-4a6b-8c2d-7e9f1a3b5c7d";
    const sibling =
      "thread:project:6f1c2a4e-8b7d-4d3a-9c5e-1a2b3c4d5e6f:0b9d7c1a-3e5f-4a6b-8c2d-7e9f1a3b5c7e";
    const items = matchComposerThreadItems({
      shells: [shell(pasted, "Fix login"), shell(sibling, "Fix logout")],
      environmentId: env,
      excludeThreadId: null,
      query: pasted,
    });
    expect(items.map((item) => item.thread.threadId)).toEqual([pasted]);
  });

  it("does not match an ID that differs from the pasted one only by case", () => {
    const pasted = "import:opencode:ses_AbC123";
    const items = matchComposerThreadItems({
      shells: [shell(pasted, "Imported A"), shell("import:opencode:ses_abc123", "Imported B")],
      environmentId: env,
      excludeThreadId: null,
      query: pasted,
    });
    expect(items.map((item) => item.thread.threadId)).toEqual([pasted]);
  });
});

import { MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { sidebarPromptMessages } from "./SidebarThreadPrompts.logic";

const message = (
  id: string,
  role: "user" | "assistant" = "user",
  createdAt = "2026-01-01T00:00:00.000Z",
  fields: { workflowScript?: boolean; idleCompaction?: "beforeCacheExpires" | "onReturn" } = {},
) => ({
  id: MessageId.make(id),
  role,
  text: id,
  createdAt: DateTime.makeUnsafe(createdAt),
  ...fields,
});

it("lists only user prompts in chronological order", () => {
  const prompts = sidebarPromptMessages([
    message("latest", "user", "2026-01-03T00:00:00.000Z"),
    message("assistant", "assistant", "2026-01-02T00:00:00.000Z"),
    message("workflow", "user", "2026-01-01T00:00:00.000Z", { workflowScript: true }),
    message("earliest", "user", "2025-12-31T00:00:00.000Z"),
    message("compaction", "user", "2025-12-30T00:00:00.000Z", {
      idleCompaction: "beforeCacheExpires",
    }),
  ]);

  expect(prompts.map(({ id }) => id)).toEqual([
    MessageId.make("earliest"),
    MessageId.make("latest"),
  ]);
});

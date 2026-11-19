import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { messageAuthorLabel } from "./index.ts";

it("uses recorded authorship instead of the provider transport role", () => {
  expect(messageAuthorLabel("user")).toBe("User");
  expect(messageAuthorLabel("assistant", { label: "Reviewer", model: "review-model" })).toBe(
    "Reviewer (review-model)",
  );
  expect(
    messageAuthorLabel("user", undefined, {
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: ThreadId.make("coordinator"),
    }),
  ).toBe("Agent (coordinator)");
  expect(
    messageAuthorLabel("user", undefined, {
      createdBy: "agent",
      creationSource: "mcp",
      linkedSender: {
        threadId: ThreadId.make("coordinator"),
        environmentId: EnvironmentId.make("lab"),
        title: "Study coordinator",
      },
    }),
  ).toBe("Agent: Study coordinator (lab)");
  expect(
    messageAuthorLabel("user", undefined, { createdBy: "system", creationSource: "server" }),
  ).toBe("System");
});

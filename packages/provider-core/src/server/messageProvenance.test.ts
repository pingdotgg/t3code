import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  formatMessageWithProvenance,
  liveMessagePurpose,
  messageProvenance,
} from "./messageProvenance.ts";

const parent = ThreadId.make("parent");
const sender = { environmentId: EnvironmentId.make("remote"), threadId: parent, title: "Parent" };
const agent = { createdBy: "agent", creationSource: "mcp" } as const;
const child = {
  lineage: { parentThreadId: parent, relationshipToParent: "subagent" as const },
};
const remote = {
  lineage: { parentThreadId: null, relationshipToParent: null },
  delegatedFrom: sender,
};

it.each([
  ["parent", { ...agent, senderThreadId: parent }, child, "delegated-assignment"],
  ["other thread", { ...agent, senderThreadId: ThreadId.make("peer") }, child, undefined],
  [
    "fork",
    { ...agent, senderThreadId: parent },
    { lineage: { ...child.lineage, relationshipToParent: "fork" as const } },
    undefined,
  ],
  ["parent notification", { ...agent, senderThreadId: parent, notification: {} }, child, undefined],
  [
    "remote parent",
    { ...agent, linkedSender: { ...sender, fromOriginatingLink: true } },
    remote,
    "delegated-assignment",
  ],
  [
    "conflicting sender identities",
    { ...agent, senderThreadId: parent, linkedSender: { ...sender, fromOriginatingLink: true } },
    remote,
    undefined,
  ],
  ["unverified remote sender", { ...agent, linkedSender: sender }, remote, undefined],
  [
    "different environment",
    {
      ...agent,
      linkedSender: {
        ...sender,
        fromOriginatingLink: true,
        environmentId: EnvironmentId.make("other"),
      },
    },
    remote,
    undefined,
  ],
  ["local ID matching a remote parent", { ...agent, senderThreadId: parent }, remote, undefined],
  [
    "human-authored schedule",
    { createdBy: "user", creationSource: "web", scheduledTaskId: "task" },
    child,
    "scheduled-task",
  ],
  ["agent-authored schedule", { ...agent, scheduledTaskId: "task" }, child, "scheduled-task"],
  [
    "scheduled task with a peer sender",
    { ...agent, scheduledTaskId: "task", senderThreadId: parent },
    child,
    undefined,
  ],
] as const)("%s receives its live message purpose", (_label, message, thread, expected) => {
  const purpose = liveMessagePurpose(message, thread);
  expect(purpose).toBe(expected);
  const text = formatMessageWithProvenance(
    "Inspect the diff.",
    messageProvenance(message),
    purpose,
  );
  if (expected === "scheduled-task")
    expect(text).toContain("T3 started this turn to run a scheduled task.");
  if (expected === undefined) expect(text).toContain("collaborator report or system event");
});

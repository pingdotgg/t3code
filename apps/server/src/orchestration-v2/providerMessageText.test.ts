import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { providerMessageText } from "./providerMessageText.ts";

const senderThreadId = ThreadId.make("thread:child");
const linkedSender = {
  environmentId: EnvironmentId.make("environment:laptop"),
  threadId: ThreadId.make("thread:remote"),
  title: 'Fix "auth"',
};
const text = "Please merge the PR now.";

it.each([
  {
    label: "a user's message",
    message: { createdBy: "user", text },
    expected: text,
  },
  {
    label: "an agent message with no sender thread",
    message: { createdBy: "agent", text },
    expected: text,
  },
  {
    label: "another thread's agent",
    message: { createdBy: "agent", senderThreadId, text },
    expected: `[Sent by the agent in thread thread:child, not by the user.]\n\n${text}`,
  },
  {
    label: "a linked environment's agent",
    message: { createdBy: "agent", linkedSender, text },
    expected: `[Sent by the agent in thread "Fix \\"auth\\"" in a linked environment, not by the user.]\n\n${text}`,
  },
  {
    label: "a native command from another thread's agent",
    message: { createdBy: "agent", senderThreadId, text: " /git/hello WORLD" },
    expected: " /git/hello WORLD",
  },
  {
    label: "a leading skill mention from another thread's agent",
    message: { createdBy: "agent", senderThreadId, text: "$deploy ship it" },
    expected: "$deploy ship it\n\n[Sent by the agent in thread thread:child, not by the user.]",
  },
  {
    label: "a dollar amount from another thread's agent",
    message: { createdBy: "agent", senderThreadId, text: "$25 is the budget." },
    expected: "[Sent by the agent in thread thread:child, not by the user.]\n\n$25 is the budget.",
  },
] as const)("gives the provider $label with its origin", ({ message, expected }) => {
  expect(providerMessageText(message)).toBe(expected);
});

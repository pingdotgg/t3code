import {
  DEFAULT_TEXT_GENERATION_MODEL,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationThread,
} from "@t3tools/contracts";

export function makeHandoverModelSelection(instanceId: ProviderInstanceId): ModelSelection {
  return {
    instanceId,
    model: DEFAULT_TEXT_GENERATION_MODEL,
    options: [{ id: "reasoningEffort", value: "high" }],
  };
}

export function formatThreadForHandover(thread: OrchestrationThread): string {
  const metadata = [
    `Title: ${thread.title}`,
    `Branch: ${thread.branch ?? "none"}`,
    `Worktree: ${thread.worktreePath ?? "project checkout"}`,
  ];
  const messages = thread.messages
    .filter((message) => message.role !== "system")
    .map((message) => `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text}`);
  return ["# Thread metadata", ...metadata, "", "# Conversation", ...messages].join("\n");
}

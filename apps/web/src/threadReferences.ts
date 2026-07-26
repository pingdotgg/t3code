import type { OrchestrationSession } from "@t3tools/contracts";

export interface ProviderThreadCopyAction {
  readonly id: "copy-provider-thread-id";
  readonly label: string;
  readonly value: string;
}

export function providerThreadCopyAction(
  session: Pick<OrchestrationSession, "providerName" | "providerThreadId"> | null,
): ProviderThreadCopyAction | null {
  const providerThreadId = session?.providerThreadId?.trim();
  const providerName = session?.providerName;
  if (!providerThreadId) {
    return null;
  }
  return {
    id: "copy-provider-thread-id",
    label: providerName === "codex" ? "Copy Codex Thread ID" : "Copy Provider Thread ID",
    value: providerThreadId,
  };
}

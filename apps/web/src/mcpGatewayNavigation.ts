import { EnvironmentId, ThreadId, type DesktopBridge } from "@t3tools/contracts";
import type { AppRouter } from "./router";

export async function openDesktopGatewayThread(
  router: Pick<AppRouter, "navigate">,
  desktop: Pick<DesktopBridge, "revealWindow"> | undefined,
  environmentId: string,
  threadId: string,
): Promise<void> {
  if (!desktop?.revealWindow) throw new Error("Desktop window focus is unavailable.");
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) },
  });
  await desktop.revealWindow();
}

export async function openDesktopGatewayAgents(
  router: Pick<AppRouter, "navigate">,
  desktop: Pick<DesktopBridge, "revealWindow"> | undefined,
): Promise<void> {
  if (!desktop?.revealWindow) throw new Error("Desktop window focus is unavailable.");
  await router.navigate({ to: "/agents" });
  await desktop.revealWindow();
}

import { threadSettlesOnTabClose } from "../components/Sidebar.logic";
import type { ThreadRouteTarget } from "../threadRoutes";
import { readEnvironmentServerConfigLoaded, readThreadShell } from "../state/entities";
import type { LayoutTab } from "./layoutModel";

export function targetSettlesOnClose(target: ThreadRouteTarget, now: string): boolean {
  if (target.kind !== "server") return false;
  if (!readEnvironmentServerConfigLoaded(target.threadRef.environmentId)) return false;
  return threadSettlesOnTabClose(readThreadShell(target.threadRef), now);
}

export function tabSettlesOnClose(tab: LayoutTab, now: string): boolean {
  return tab.content.kind === "chat" && targetSettlesOnClose(tab.content.target, now);
}

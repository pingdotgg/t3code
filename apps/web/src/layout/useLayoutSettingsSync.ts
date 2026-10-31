import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import type { LayoutTabContent } from "./layoutModel";

/** The route that shows a chat tab's thread. */
export function layoutChatRoute(content: Extract<LayoutTabContent, { kind: "chat" }>) {
  const target = content.target;
  return target.kind === "server"
    ? { to: "/$environmentId/$threadId" as const, params: buildThreadRouteParams(target.threadRef) }
    : { to: "/draft/$draftId" as const, params: buildDraftThreadRouteParams(target.draftId) };
}

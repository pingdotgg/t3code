import {
  isRuntimeModeAbove,
  linkOriginIsFenced,
  type OrchestrationV2LinkOrigin,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * A caller's answer for who asked. Whether a person approved the command's text and whether
 * policy allows it are not the caller's to answer: this service checks both at every run.
 */
export type ProjectCommands = "permitted" | "request-not-permitted" | "agent-below-full-access";

/**
 * The answer as a caller hands it over: settled when it cannot change while the request lasts,
 * or one to ask again each time a command's turn comes, as for a thread whose modes can change.
 */
export type ProjectCommandsNow = ProjectCommands | Effect.Effect<ProjectCommands>;

/**
 * A layout command is the project owner's own code. A link paired below full access grants T3's
 * tools only (see `mcp/linkOrigin.ts`), so work it started never runs one.
 */
export const projectCommandsForLink = (
  origin: OrchestrationV2LinkOrigin | undefined,
): ProjectCommands =>
  origin === undefined || !linkOriginIsFenced(origin) ? "permitted" : "request-not-permitted";

/**
 * For a worktree an agent asked for. Below Full access the agent's own commands wait for a
 * person, so the project's do not run for it either, approved or not. `maxRuntimeMode` is the
 * administrator's limit: a thread recorded above it starts no work in that mode, so it is not in
 * Full access here whatever it records.
 */
export const projectCommandsForAgent = (
  origin: OrchestrationV2LinkOrigin | undefined,
  modes: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  },
  maxRuntimeMode: RuntimeMode | undefined,
): ProjectCommands => {
  const link = projectCommandsForLink(origin);
  if (link !== "permitted") return link;
  return modes.runtimeMode === "full-access" &&
    !isRuntimeModeAbove(modes.runtimeMode, maxRuntimeMode) &&
    modes.interactionMode === "default"
    ? "permitted"
    : "agent-below-full-access";
};

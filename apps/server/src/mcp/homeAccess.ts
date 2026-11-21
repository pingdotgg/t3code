import { isHomeThreadId, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import * as HomeService from "../home/HomeService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * `McpSchema.EnabledWhen` for Home's tools: only a `home:` thread lists them, so ordinary threads
 * pay nothing for them. Discovery only; `requireHomeCaller` checks the grant on every call.
 */
export const hiddenFromNonHomeThreads = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.thread !== undefined && isHomeThreadId(scope.thread.threadId);
};

const notHome = new OrchestratorMcpFailure({
  code: "capability_denied",
  message: "Only the active Home thread can use Home's tools.",
});

/** The calling thread, when it is the active Home right now. Read on every call. */
export const requireHomeCaller = Effect.fn("mcp.requireHomeCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const thread = scope.thread;
  if (thread === undefined || thread.subagent === true) return yield* notHome;
  const home = yield* HomeService.HomeService;
  if (!(yield* home.isHome(thread.threadId))) return yield* notHome;
  return thread.threadId;
});

/** Watches a thread Home just launched here. Other callers, and a failed save, change nothing. */
export const watchIfLaunchedByHome = Effect.fn("mcp.watchIfLaunchedByHome")(function* (
  threadId: ThreadId,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = scope.thread?.threadId;
  if (caller === undefined || !isHomeThreadId(caller)) return;
  // Optional so the launch tool needs no Home where Home is never built, as in its tests.
  const home = yield* Effect.serviceOption(HomeService.HomeService);
  if (Option.isNone(home)) return;
  yield* home.value
    .addWatch(caller, { threadId, reason: "launched" })
    .pipe(Effect.ignoreCause({ log: true }));
});

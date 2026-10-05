import {
  type EnvironmentId,
  type FleetInput,
  type FleetOperation,
  type FleetRequest,
  type FleetResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FleetBroker from "../home/FleetBroker.ts";
import * as FleetService from "../home/FleetService.ts";
import * as HomeService from "../home/HomeService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { readCaller, readFullAccessCaller } from "./threadAccess.ts";

/** Services a tool needs to declare when it routes Home calls. */
export const homeRoutingDependencies = [
  HomeService.HomeService,
  FleetService.FleetService,
  FleetBroker.FleetBroker,
] as const;

/**
 * Whether the calling thread is Home. Read on every call. A credential that
 * cannot control threads, or a client outside a thread, is never Home, so the
 * tool's own capability check still runs first.
 */
export const callerIsHome = Effect.fn("mcp.callerIsHome")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration") || scope.thread === undefined) return false;
  const home = yield* HomeService.HomeService;
  return yield* home.isHome(scope.thread.threadId);
});

/** Whether each operation changes state. A new operation must pick a side. */
const CHANGES_STATE = {
  capabilities: false,
  "projects.list": false,
  "threads.list": false,
  "threads.read": false,
  "requests.list": false,
  "requests.read": false,
  "threads.launch": true,
  "threads.send": true,
  "threads.interrupt": true,
  "threads.organize": true,
  "threads.rename": true,
  "requests.respond": true,
} satisfies Record<FleetOperation, boolean>;

/**
 * Reads the caller for a change Home makes. A change needs a live Home run in
 * full-access/default mode, so switching Home to plan or a narrower runtime
 * mode makes it read-only everywhere.
 */
export const readHomeChangeCaller = Effect.fn("mcp.readHomeChangeCaller")(function* () {
  return yield* readFullAccessCaller("Home makes changes only in full-access/default mode.");
});

/** Runs a fleet operation as Home, here or in the environment it names. */
export const runAsHome = Effect.fn("mcp.runAsHome")(function* <Op extends FleetOperation>(
  environmentId: EnvironmentId | undefined,
  op: Op,
  input: FleetInput<Op>,
) {
  const { scope } = CHANGES_STATE[op] ? yield* readHomeChangeCaller() : yield* readCaller();
  // Checked again here, right before acting: Home may have been turned off or
  // started fresh while the tool did earlier work.
  if (scope.thread === undefined || !(yield* callerIsHome())) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only Home can act with the user's reach.",
    });
  }
  const invoke = {
    actor: { environmentId: scope.environmentId, threadId: scope.thread.threadId },
    // The pairing of op and input is what FleetInput<Op> guarantees.
    request: { op, input } as FleetRequest,
  };
  const result =
    environmentId === undefined || environmentId === scope.environmentId
      ? yield* (yield* FleetService.FleetService).execute(invoke)
      : yield* (yield* FleetBroker.FleetBroker).invoke(environmentId, invoke);
  // Local results come from the typed handlers; remote ones are decoded per op.
  return result as FleetResult<Op>;
});

/**
 * Routes a tool call from Home to the environment it names, with Home's reach
 * over every project. Returns None for any other caller, which keeps its
 * calling-project reach and may only name its own environment.
 */
export const routeHome = Effect.fn("mcp.routeHome")(function* <Op extends FleetOperation>(
  environmentId: EnvironmentId | undefined,
  op: Op,
  input: FleetInput<Op>,
) {
  if (yield* callerIsHome()) {
    return Option.some(yield* runAsHome(environmentId, op, input));
  }
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (environmentId !== undefined && environmentId !== scope.environmentId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only Home can act in another environment.",
    });
  }
  return Option.none<FleetResult<Op>>();
});

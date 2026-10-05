import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FleetInvokeInput,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as FleetBroker from "../home/FleetBroker.ts";
import * as FleetService from "../home/FleetService.ts";
import * as HomeService from "../home/HomeService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { routeHome } from "./homeRouting.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const hub = EnvironmentId.make("hub");
const studio = EnvironmentId.make("studio");
const callerId = ThreadId.make("caller");
const target = ThreadId.make("target");
const result = { requestIds: [] };

const liveCaller = {
  id: callerId,
  deletedAt: null,
  archivedAt: null,
  activeRunId: "run",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  interactionMode: "default",
};

const setup = (isHome: boolean, caller: Partial<typeof liveCaller> = {}) => {
  const local: Array<FleetInvokeInput> = [];
  const remote: Array<[EnvironmentId, FleetInvokeInput]> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: hub,
      requestNamespace: "session",
      thread: {
        threadId: callerId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ ...liveCaller, ...caller } as unknown as OrchestrationV2ThreadShell),
    }),
    Layer.mock(HomeService.HomeService)({ available: true, isHome: () => Effect.succeed(isHome) }),
    Layer.mock(FleetService.FleetService)({
      execute: (input) => {
        local.push(input);
        return Effect.succeed(result);
      },
    }),
    Layer.mock(FleetBroker.FleetBroker)({
      invoke: (environmentId, input) => {
        remote.push([environmentId, input]);
        return Effect.succeed(result);
      },
    }),
  );
  return { layer, local, remote };
};

it.effect("keeps other threads in their own environment", () => {
  const { layer, local, remote } = setup(false);
  return Effect.gen(function* () {
    const error = yield* routeHome(studio, "requests.list", { threadId: target }).pipe(Effect.flip);
    expect(error.code).toBe("capability_denied");
    expect(Option.isNone(yield* routeHome(hub, "requests.list", { threadId: target }))).toBe(true);
    expect(local).toHaveLength(0);
    expect(remote).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("runs Home's calls here or relays them to the environment it names", () => {
  const { layer, local, remote } = setup(true);
  return Effect.gen(function* () {
    yield* routeHome(undefined, "requests.list", { threadId: target });
    yield* routeHome(studio, "requests.list", { threadId: target });
    const actor = { environmentId: hub, threadId: callerId };
    expect(local).toEqual([
      { actor, request: { op: "requests.list", input: { threadId: target } } },
    ]);
    expect(remote).toEqual([
      [studio, { actor, request: { op: "requests.list", input: { threadId: target } } }],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("lets Home read but not change anything outside full-access/default mode", () => {
  const { layer, local, remote } = setup(true, { interactionMode: "plan" });
  return Effect.gen(function* () {
    yield* routeHome(undefined, "requests.list", { threadId: target });
    const error = yield* routeHome(studio, "threads.send", {
      threadId: target,
      message: "Ship it.",
    }).pipe(Effect.flip);
    expect(error.code).toBe("capability_denied");
    expect(local).toHaveLength(1);
    expect(remote).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

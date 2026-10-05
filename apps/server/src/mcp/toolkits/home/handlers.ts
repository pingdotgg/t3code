import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as FleetBroker from "../../../home/FleetBroker.ts";
import * as HomeService from "../../../home/HomeService.ts";
import { callerIsHome, readHomeChangeCaller } from "../../homeRouting.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { HomeToolkit } from "./tools.ts";

export const HomeHandlersLive = HomeToolkit.toLayer({
  t3_environment_list: () =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const descriptor = yield* environment.getDescriptor;
      const current = {
        environmentId: scope.environmentId,
        label: descriptor.label,
        connected: true,
        current: true,
      };
      if (!(yield* callerIsHome())) {
        return {
          currentEnvironmentId: scope.environmentId,
          relayConnected: false,
          environments: [current],
        };
      }
      const reach = yield* (yield* FleetBroker.FleetBroker).reach;
      return {
        currentEnvironmentId: scope.environmentId,
        relayConnected: reach.hostConnected,
        environments: [
          current,
          ...reach.environments
            .filter((candidate) => candidate.environmentId !== scope.environmentId)
            .map((candidate) => ({ ...candidate, current: false })),
        ],
      };
    }),

  t3_thread_watch: (input) =>
    Effect.gen(function* () {
      if (!(yield* callerIsHome()))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Home can watch threads.",
        });
      const { scope } = yield* readHomeChangeCaller();
      const homeThreadId = scope.thread?.threadId;
      if (homeThreadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Home can watch threads.",
        });
      const home = yield* HomeService.HomeService;
      const environmentId = input.environmentId ?? scope.environmentId;
      const { threadId } = input;
      if ((input.action === "watch" || input.action === "unwatch") && threadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${input.action} needs threadId.`,
        });
      const next = yield* home
        .updateWatches(homeThreadId, (current) => {
          switch (input.action) {
            case "watch_all":
              return { ...current, watchAll: true };
            case "unwatch_all":
              return { ...current, watchAll: false };
            case "watch":
              return HomeService.addWatch(current, {
                environmentId,
                threadId: threadId!,
                reason: "requested",
              });
            case "unwatch":
              return HomeService.removeWatch(current, { environmentId, threadId: threadId! });
          }
        })
        .pipe(Effect.mapError(unavailable));
      return { watchAll: next.watchAll, watches: next.watches };
    }),
});

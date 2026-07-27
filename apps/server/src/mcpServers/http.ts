import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { discoverGlobalMcpInventory } from "./McpServerInventory.ts";
import { planDisabledMcpServersWrite } from "./McpServerToggle.ts";

export const mcpServersHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mcpServers",
  Effect.fnUntraced(function* (handlers) {
    const settingsService = yield* ServerSettingsService;
    // `updateSettings` locks around its own write, but the disable list is
    // computed from a settings snapshot read before that lock. Serialize the
    // whole read-plan-write here so two overlapping toggles cannot both plan
    // from the same snapshot and drop one another's entry.
    const toggleSemaphore = yield* Semaphore.make(1);

    return handlers
      .handle(
        "inventory",
        Effect.fn("environment.mcpServers.inventory")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* discoverGlobalMcpInventory();
        }),
      )
      .handle(
        "setEnabled",
        Effect.fn("environment.mcpServers.setEnabled")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          yield* toggleSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const settings = yield* settingsService.getSettings.pipe(
                Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
              );
              const plan = planDisabledMcpServersWrite(settings, {
                instanceId: args.payload.providerInstanceId,
                name: args.payload.name,
                enabled: args.payload.enabled,
              });
              if (plan.kind === "unsupported") {
                return yield* failEnvironmentInvalidRequest("invalid_command");
              }

              yield* settingsService
                .updateSettings(plan.patch)
                .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
            }),
          );

          return yield* discoverGlobalMcpInventory();
        }),
      );
  }),
);

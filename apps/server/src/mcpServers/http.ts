import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

          const target = {
            instanceId: args.payload.providerInstanceId,
            name: args.payload.name,
            enabled: args.payload.enabled,
          };
          const settings = yield* settingsService.getSettings.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          if (planDisabledMcpServersWrite(settings, target).kind === "unsupported") {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }

          // Re-plan inside the settings write lock: the disable list is a
          // read-modify-write, so planning from a snapshot taken outside the
          // lock could drop a concurrent writer's changes.
          yield* settingsService
            .updateSettingsWith((current) => {
              const plan = planDisabledMcpServersWrite(current, target);
              return plan.kind === "unsupported" ? undefined : plan.patch;
            })
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));

          return yield* discoverGlobalMcpInventory();
        }),
      );
  }),
);

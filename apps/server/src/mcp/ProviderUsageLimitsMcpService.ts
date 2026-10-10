import { OrchestratorMcpFailure, type ProviderUsageLimitsMcpResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitsService from "../usage/UsageLimitsService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { readCaller } from "./threadAccess.ts";

export class ProviderUsageLimitsMcpService extends Context.Service<
  ProviderUsageLimitsMcpService,
  {
    readonly read: Effect.Effect<
      ProviderUsageLimitsMcpResult,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext | ThreadManagementService.ThreadManagementService
    >;
  }
>()("t3/mcp/ProviderUsageLimitsMcpService") {}

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const usageLimits = yield* UsageLimitsService.UsageLimitsService;
  const read = Effect.gen(function* () {
    const caller = yield* readCaller();
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId !== caller.scope.environmentId)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential belongs to another environment.",
      });
    return yield* usageLimits.read;
  });
  return ProviderUsageLimitsMcpService.of({ read });
});

export const layer = Layer.effect(ProviderUsageLimitsMcpService, make);

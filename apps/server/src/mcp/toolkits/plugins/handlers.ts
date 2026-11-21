import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PluginService } from "../../../plugins/PluginService.ts";
import { readCaller } from "../../threadAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PluginsToolkit } from "./tools.ts";

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const failure = (cause: { readonly message: string }) =>
  isOrchestratorMcpFailure(cause)
    ? cause
    : new OrchestratorMcpFailure({ code: "orchestration_error", message: cause.message });

export const PluginsHandlersLive = McpToolAccess.toLayer(PluginsToolkit, {
  plugins_authoring_guide: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* PluginService).authoringGuide(input);
    }),
  ),
  plugins_registry_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* PluginService).registryList(input).pipe(Effect.mapError(failure));
    }),
  ),
  plugins_registry_install: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<Effect.Services<typeof check>>();
      const authorize = check.pipe(Effect.asVoid, Effect.provideContext(context));
      return yield* (yield* PluginService)
        .registryInstall(input, authorize)
        .pipe(Effect.mapError(failure));
    }),
  ),
  plugins_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* PluginService).list(input);
    }),
  ),
  plugins_set_enabled: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<Effect.Services<typeof check>>();
      const authorize = check.pipe(Effect.asVoid, Effect.provideContext(context));
      return yield* (yield* PluginService)
        .setEnabled(input, authorize)
        .pipe(Effect.mapError(failure));
    }),
  ),
  plugins_reload: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<Effect.Services<typeof check>>();
      const authorize = check.pipe(Effect.asVoid, Effect.provideContext(context));
      return yield* (yield* PluginService).reload(input, authorize).pipe(Effect.mapError(failure));
    }),
  ),
  plugins_invoke: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<Effect.Services<typeof check>>();
      const authorize = check.pipe(Effect.asVoid, Effect.provideContext(context));
      return yield* (yield* PluginService).invoke(input, authorize).pipe(Effect.mapError(failure));
    }),
  ),
});

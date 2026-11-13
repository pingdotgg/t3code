import * as Effect from "effect/Effect";
import * as ExtensionService from "../../../extensions/ExtensionService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { type ExtensionError, OrchestratorMcpFailure } from "@t3tools/contracts";
import { ExtensionsToolkit } from "./tools.ts";

const extensionFailure = (error: ExtensionError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid-input" || error.reason === "invalid-manifest"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message.slice(0, 8192),
  });

export const layer = McpToolAccess.toLayer(ExtensionsToolkit, {
  extensions_settings: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      yield* check;
      const extensions = yield* ExtensionService.ExtensionService;
      return yield* extensions.setSettings(input).pipe(Effect.mapError(extensionFailure));
    }),
  ),
  extensions_development: McpToolAccess.reads(() =>
    Effect.flatMap(ExtensionService.ExtensionService, (extensions) => extensions.developmentSkill),
  ),
  // Listing includes stored settings, so it needs the same access as settings changes.
  extensions_list: McpToolAccess.writesEnvironment((_input, check) =>
    Effect.gen(function* () {
      yield* check;
      const extensions = yield* ExtensionService.ExtensionService;
      return yield* extensions.list.pipe(Effect.mapError(extensionFailure));
    }),
  ),
  extensions_invoke: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      yield* check;
      const extensions = yield* ExtensionService.ExtensionService;
      const caller = yield* McpInvocationContext.McpInvocationContext;
      return yield* extensions
        .invoke({
          ...input,
          context: {
            ...input.context,
            ...(caller.thread ? { threadId: caller.thread.threadId } : {}),
            surface: "agent",
          },
        })
        .pipe(Effect.mapError(extensionFailure));
    }),
  ),
  extensions_install: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      yield* check;
      const extensions = yield* ExtensionService.ExtensionService;
      return yield* extensions.install(input).pipe(Effect.mapError(extensionFailure));
    }),
  ),
  extensions_manage: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      yield* check;
      const extensions = yield* ExtensionService.ExtensionService;
      return yield* extensions.manage(input).pipe(Effect.mapError(extensionFailure));
    }),
  ),
});

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as CodexPluginMarketplace from "./CodexPluginMarketplace.ts";

export const pluginMarketplaceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "plugins",
  Effect.fnUntraced(function* (handlers) {
    const marketplace = yield* CodexPluginMarketplace.CodexPluginMarketplace;

    return handlers
      .handle(
        "catalog",
        Effect.fn("environment.plugins.catalog")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* marketplace.catalog(args.payload?.q);
        }),
      )
      .handle(
        "detail",
        Effect.fn("environment.plugins.detail")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* marketplace.detail(args.params.pluginId);
        }),
      )
      .handle(
        "logo",
        Effect.fn("environment.plugins.logo")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* marketplace.logo(args.params.pluginId);
        }),
      )
      .handle(
        "mcpAuth",
        Effect.fn("environment.plugins.mcpAuth")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* marketplace.mcpAuth(args.params.pluginId);
        }),
      )
      .handle(
        "startMcpAuth",
        Effect.fn("environment.plugins.startMcpAuth")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* marketplace.startMcpAuth(
            args.params.pluginId,
            args.payload.harness,
            args.payload.serverId,
          );
        }),
      )
      .handle(
        "completeMcpAuth",
        Effect.fn("environment.plugins.completeMcpAuth")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* marketplace.completeMcpAuth(
            args.params.pluginId,
            args.payload.harness,
            args.payload.serverId,
            args.payload.callbackUrl,
          );
        }),
      )
      .handle(
        "disconnectMcpAuth",
        Effect.fn("environment.plugins.disconnectMcpAuth")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* marketplace.disconnectMcpAuth(
            args.params.pluginId,
            args.payload.harness,
            args.payload.serverId,
          );
        }),
      )
      .handle(
        "install",
        Effect.fn("environment.plugins.install")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* marketplace.install(args.params.pluginId);
        }),
      )
      .handle(
        "setup",
        Effect.fn("environment.plugins.setup")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* marketplace.setup(args.params.pluginId, args.payload.action);
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.plugins.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* marketplace.remove(args.params.pluginId);
        }),
      );
  }),
);

// Calls one T3 MCP tool against a running dev server, authenticating the way `t3 thread start` does.
// Seeding uses it for t3_thread_launch without a message (an idle thread, no provider turn) and for
// link_pull_request. usage: node mcp-call.ts <home-dir> <tool> '<json args>'

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";

import * as EnvironmentAuth from "../../../../server/src/auth/EnvironmentAuth.ts";
import { resolveCliAuthConfig } from "../../../../server/src/cli/config.ts";
import * as ServerConfig from "../../../../server/src/config.ts";
import { mcpToolSession } from "../../../../server/src/mcp/AcpMcpStdioBridge.ts";
import { readPersistedServerRuntimeState } from "../../../../server/src/serverRuntimeState.ts";

const [homeDir, tool, args] = process.argv.slice(2);

const program = Effect.gen(function* () {
  const config = yield* resolveCliAuthConfig({ baseDir: Option.some(homeDir!) }, Option.none());
  return yield* Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(state)) return yield* Effect.die("server is not running");
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* auth.issueMcpClientSession({
      label: "pr-22930 evidence seed",
      access: "full-access",
      client: { deviceType: "bot" },
    });
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", state.value.origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: "pr-22930-evidence",
    });
    const result = yield* session.call(tool!, JSON.parse(args ?? "{}"));
    console.log(JSON.stringify(result));
    yield* auth.revokeSession(issued.sessionId).pipe(Effect.ignore);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

program.pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  NodeRuntime.runMain,
);

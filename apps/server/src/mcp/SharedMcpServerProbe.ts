/**
 * SharedMcpServerProbe — Settings' view of a saved shared MCP server: check
 * that it answers through T3's proxy, and start its OAuth sign-in.
 *
 * @module mcp/SharedMcpServerProbe
 */
import {
  type SharedMcpServer,
  type SharedMcpServerSignInResult,
  SharedMcpServerTestError,
  type SharedMcpServerTestResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";
import { SharedMcpProxy, type SharedMcpProxyError } from "./SharedMcpProxy.ts";

const PROBE_TIMEOUT = "10 seconds";

export class SharedMcpServerProbe extends Context.Service<
  SharedMcpServerProbe,
  {
    /** Connect to the named saved server through the proxy and count its tools. */
    readonly test: (input: {
      readonly name: string;
    }) => Effect.Effect<SharedMcpServerTestResult, SharedMcpServerTestError>;
    /** Start the named server's OAuth sign-in, redirecting back to `redirectBaseUrl`. */
    readonly signIn: (input: {
      readonly name: string;
      readonly redirectBaseUrl: string;
    }) => Effect.Effect<SharedMcpServerSignInResult, SharedMcpServerTestError>;
  }
>()("t3/mcp/SharedMcpServerProbe") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const proxy = yield* SharedMcpProxy;

  const fail = (server: string, message: string, needsSignIn = false) =>
    Effect.fail(new SharedMcpServerTestError({ server, message, needsSignIn }));
  const fromProxy = (error: SharedMcpProxyError) =>
    fail(error.server, error.message, error.needsSignIn);
  const saved = (name: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catch(() => fail(name, "Could not read settings.")),
      );
      const server: SharedMcpServer | undefined = settings.sharedMcpServers.find(
        (entry) => entry.name === name,
      );
      return server ?? (yield* fail(name, "This server is no longer saved."));
    });

  const test = Effect.fn("SharedMcpServerProbe.test")(function* (input: { readonly name: string }) {
    const server = yield* saved(input.name);
    return yield* proxy.probe(server).pipe(
      Effect.timeoutOrElse({
        duration: PROBE_TIMEOUT,
        orElse: () => fail(input.name, "The server did not answer within 10 seconds."),
      }),
      Effect.catchTags({ SharedMcpProxyError: fromProxy }),
    );
  });

  const signIn = Effect.fn("SharedMcpServerProbe.signIn")(function* (input: {
    readonly name: string;
    readonly redirectBaseUrl: string;
  }) {
    const server = yield* saved(input.name);
    return yield* proxy
      .startSignIn(server, input.redirectBaseUrl)
      .pipe(Effect.catchTags({ SharedMcpProxyError: fromProxy }));
  });

  return SharedMcpServerProbe.of({ test, signIn });
});

export const layer = Layer.effect(SharedMcpServerProbe, make);

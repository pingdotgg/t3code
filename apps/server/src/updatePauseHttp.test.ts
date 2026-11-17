// @effect-diagnostics globalFetch:off globalFetchInEffect:off - real HTTP route boundary test.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentServerHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import { UpdatePause } from "./updatePause.ts";
import * as UpdatePauseHttp from "./updatePauseHttp.ts";

const sessionId = Schema.decodeSync(AuthSessionId)("update-pause-test");

const principal = (...scopes: AuthEnvironmentScope[]) =>
  Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId,
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(scopes),
      }),
    ),
  );

it.live.each([
  { scopes: [AuthOrchestrationOperateScope], status: 403, pauses: 0 },
  { scopes: [AuthEnvironmentMaintainScope], status: 200, pauses: 1 },
])("pauses runs for an update only with environment:maintain ($status)", (row) =>
  Effect.gen(function* () {
    let pauses = 0;
    const routes = HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentServerHttpApi),
    ).pipe(
      Layer.provide(UpdatePauseHttp.layer),
      Layer.provide(principal(...row.scopes)),
      Layer.provide(
        Layer.succeed(UpdatePause, {
          pauseRunsForUpdate: Effect.sync(() => {
            pauses += 1;
            return { pausedRuns: 2 };
          }),
          resumeRunsAfterUpdate: Effect.die("unexpected resume"),
        }),
      ),
    );
    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
    const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
    const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
    const response = yield* Effect.promise(() =>
      fetch(`http://${host}:${address.port}/api/server/pause-for-update`, { method: "POST" }),
    );
    expect(response.status).toBe(row.status);
    if (row.status === 200) {
      expect(yield* Effect.promise(() => response.json())).toEqual({ pausedRuns: 2 });
    }
    expect(pauses).toBe(row.pauses);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

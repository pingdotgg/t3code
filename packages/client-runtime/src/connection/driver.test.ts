import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );

  it.effect("refreshes a browser's cookie session while its connection stays open", () =>
    Effect.gen(function* () {
      const sessionRequests = yield* Ref.make(0);
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Test environment",
        httpBaseUrl: "http://127.0.0.1:1",
        wsBaseUrl: "ws://127.0.0.1:1",
      });
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: () =>
                Effect.succeed({
                  environmentId: target.environmentId,
                  label: target.label,
                  httpBaseUrl: target.httpBaseUrl,
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.succeed({
                  client: {} as RpcSession.RpcSession["client"],
                  initialConfig: Effect.die(new Error("Not used by driver tests.")),
                  subscribeServerConfig: () => Stream.never,
                  ready: Effect.void,
                  probe: Effect.void,
                  inboundFrames: Effect.succeed(0),
                  closed: Effect.never,
                } satisfies RpcSession.RpcSession),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
              rememberCheckedDescriptor: () => Effect.void,
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.gen(function* () {
                  if (request.url.endsWith("/api/auth/session")) {
                    yield* Ref.update(sessionRequests, (count) => count + 1);
                  }
                  return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
                }),
              ),
            ),
          ),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* driver.connect(
            { target, profile: Option.none(), enabled: true, alternateRoutes: [] },
            () => Effect.void,
          );
          expect(yield* Ref.get(sessionRequests)).toBe(0);
          yield* TestClock.adjust("12 hours");
          expect(yield* Ref.get(sessionRequests)).toBe(1);
          yield* TestClock.adjust("12 hours");
          expect(yield* Ref.get(sessionRequests)).toBe(2);
        }),
      );
    }),
  );
});

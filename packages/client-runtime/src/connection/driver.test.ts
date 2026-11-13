import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
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

  it.effect(
    "withholds the session credential from a host that no longer answers as this environment",
    () =>
      Effect.gen(function* () {
        const authorizations = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
        const driver = yield* ConnectionDriver.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ConnectionResolver.ConnectionResolver)({}),
              Layer.mock(RpcSession.RpcSessionFactory)({}),
              Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
                rememberCheckedDescriptor: () => Effect.void,
              }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Ref.update(authorizations, (all) => [...all, request.headers.authorization]).pipe(
                    Effect.as(
                      HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        const target = new BearerConnectionTarget({
          environmentId: EnvironmentId.make("environment-1"),
          label: "Desk",
          connectionId: "lan",
        });

        const grant = yield* driver.sessionGrant({
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: "http://192.168.1.10:3773/",
          socketUrl: "ws://192.168.1.10:3773/ws",
          httpAuthorization: { _tag: "Bearer", token: "secret" },
          target,
        });

        expect(grant).toEqual(Option.none());
        expect(yield* Ref.get(authorizations)).toEqual([undefined]);
      }),
  );
});

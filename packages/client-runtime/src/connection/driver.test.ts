import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionBlockedError,
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

  it.effect("a silent route's network failure does not hide an answered route's refusal", () =>
    Effect.gen(function* () {
      const refused = new ConnectionBlockedError({
        reason: "authentication",
        hop: "server",
        detail: "Session token revoked.",
      });
      const attempted: Array<string> = [];
      const error = yield* ConnectionDriver.connectOverRoutes(
        ENTRY,
        (route) =>
          Effect.succeed<ConnectionDriver.RouteCheck>(
            route.target === ENTRY.target ? "answered" : "silent",
          ),
        (route) => {
          attempted.push(route.target.label);
          return route.target === ENTRY.target
            ? Effect.fail(refused)
            : Effect.fail(
                new ConnectionTransientError({ reason: "transport", detail: "Timed out." }),
              );
        },
      ).pipe(Effect.scoped, Effect.flip);

      // A refusal does not retry, so the silent route still gets its chance to connect.
      expect(attempted).toHaveLength(2);
      expect(error).toBe(refused);
    }),
  );
});

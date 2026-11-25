import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { createPreviewTunnelUrlReader } from "./previewTunnel.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PREPARED: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.test",
  socketUrl: "wss://remote.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "token" },
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Remote environment",
    connectionId: "connection-1",
  }),
};

const DPOP_AUTHORIZATION = {
  _tag: "Dpop",
  accessToken: "access",
  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
} as const;

describe("preview tunnel url", () => {
  it.live("waits for a reconnecting environment instead of refusing the page", () =>
    Effect.gen(function* () {
      const prepared = Atom.make(Option.none<PreparedConnection>());
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ ticket: "media-ticket", expiresAt: "2999-01-01T00:00:00.000Z" }),
          ),
        ),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const read = createPreviewTunnelUrlReader({
        runtime: Atom.runtime(Layer.succeed(HttpClient.HttpClient, client)),
        registry,
        preparedConnectionAtom: () => prepared,
      });

      const pending = yield* Effect.forkChild(Effect.promise(() => read(ENVIRONMENT_ID)));
      yield* Effect.yieldNow;
      registry.set(prepared, Option.some(PREPARED));

      expect(yield* Fiber.join(pending)).toBe(
        "wss://remote.example.test/api/preview/tunnel?wsTicket=media-ticket",
      );
    }),
  );

  it.live("signs a fresh upgrade proof for each connection over a DPoP ticket", () =>
    Effect.gen(function* () {
      let proofs = 0;
      const signed: Array<ManagedRelay.ManagedRelayDpopProofInput> = [];
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ ticket: "media-ticket", expiresAt: "2999-01-01T00:00:00.000Z" }),
          ),
        ),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const read = createPreviewTunnelUrlReader({
        runtime: Atom.runtime(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
              authorizeDpopHttp: () =>
                Effect.succeed({
                  environmentId: ENVIRONMENT_ID,
                  label: PREPARED.label,
                  httpBaseUrl: PREPARED.httpBaseUrl,
                  httpAuthorization: DPOP_AUTHORIZATION,
                }),
            }),
            Layer.mock(ManagedRelay.ManagedRelayDpopSigner)({
              createProof: (input) =>
                Effect.sync(() => {
                  signed.push(input);
                  return `proof-${++proofs}`;
                }),
            }),
          ),
        ),
        registry,
        preparedConnectionAtom: () =>
          Atom.make(
            Option.some<PreparedConnection>({
              ...PREPARED,
              httpAuthorization: DPOP_AUTHORIZATION,
            }),
          ),
      });

      const first = new URL((yield* Effect.promise(() => read(ENVIRONMENT_ID)))!);
      const second = new URL((yield* Effect.promise(() => read(ENVIRONMENT_ID)))!);
      expect(first.searchParams.get("wsTicket")).toBe("media-ticket");
      expect(second.searchParams.get("wsTicket")).toBe("media-ticket");
      expect(first.searchParams.get("dpop")).not.toBe(second.searchParams.get("dpop"));
      const upgrades = signed.filter((input) => input.method === "GET");
      expect(upgrades).toHaveLength(2);
      expect(upgrades[0]).toMatchObject({
        url: "https://remote.example.test/api/preview/tunnel",
        accessToken: "media-ticket",
      });
      expect(upgrades[0]?.secureChannel).toBeUndefined();
    }),
  );
});

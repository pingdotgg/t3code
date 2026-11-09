import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import { mintConnectMcpApprovalCode } from "./peerPairingCode.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const RELAY_ORIGIN = "https://prod-abc.t3coderelay.test";

function harness() {
  const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), body: JSON.parse(String(init?.body)) });
    return Response.json({
      id: "grant-1",
      credential: "T3-AUTO-CODE",
      expiresAt: "2026-11-09T12:05:00.000Z",
      access: "auto",
    });
  };
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization
      | ManagedRelay.ManagedRelayDpopSigner
      | HttpClient.HttpClient
    >,
  ) =>
    effect.pipe(
      Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
      Effect.provideService(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
          authorizeBearer: () => Effect.die("unexpected bearer authorization"),
          authorizeDpop: () => Effect.die("unexpected socket authorization"),
          authorizeDpopHttp: () =>
            Effect.succeed({
              environmentId: ENVIRONMENT_ID,
              label: "Box",
              httpBaseUrl: RELAY_ORIGIN,
              httpAuthorization: { _tag: "Dpop", accessToken: "token", expiresAtEpochMs: 1 },
            }),
          rememberCheckedDescriptor: () => Effect.void,
          renewDpopBeforeExpiry: () => Effect.die("unexpected renewal"),
        }),
      ),
      Effect.provideService(
        ManagedRelay.ManagedRelayDpopSigner,
        ManagedRelay.ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("thumbprint"),
          createProof: () => Effect.succeed("proof"),
        }),
      ),
    );
  return { calls, provide };
}

describe("mintConnectMcpApprovalCode", () => {
  it.effect("mints only for a sign-in page on the environment's relay address", () =>
    Effect.gen(function* () {
      const { calls, provide } = harness();
      const mint = (pageOrigin: string) =>
        provide(
          mintConnectMcpApprovalCode({ environmentId: ENVIRONMENT_ID, pageOrigin, access: "auto" }),
        ).pipe(Effect.result);

      const elsewhere = yield* mint("https://attacker.example");
      expect(Result.isFailure(elsewhere) && elsewhere.failure.reason).toBe("other_address");
      expect(calls).toEqual([]);

      expect(yield* mint(RELAY_ORIGIN)).toEqual(Result.succeed("T3-AUTO-CODE"));
      expect(calls).toEqual([
        {
          url: `${RELAY_ORIGIN}/api/auth/pairing-token`,
          body: { label: "App sign-in", access: "auto" },
        },
      ]);
    }),
  );
});

import { EnvironmentId, type TailcatAddress, type TailcatNodeKey } from "@t3tools/contracts";
import { encodeTailcatConnectionCode } from "@t3tools/shared/t3ConnectionCode";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { TailcatEnvironmentGateway } from "../platform/capabilities.ts";
import { prepareTailcatRegistration } from "./onboarding.ts";

const ADDRESS =
  "tco2FwWCBsyGP41dXrPe-jN6lGVysle1gLOeO06eQXFFnAEyTVWmFrWCBXI4Jlw0AzfV9loUv7embdWaR2qZD6dhGPBqQDMD1-a2FpGQEu" as TailcatAddress;
const NODE_KEY = `nodekey:${"ab".repeat(32)}` as TailcatNodeKey;
const ENVIRONMENT_ID = EnvironmentId.make("environment-tailcat");

const code = (options: { readonly withPairingToken?: boolean } = {}) =>
  encodeTailcatConnectionCode({
    v: 1,
    transport: "tailcat",
    address: ADDRESS,
    port: 47831,
    environmentId: ENVIRONMENT_ID,
    name: "gpu-box",
    serverVersion: "0.0.38",
    ...(options.withPairingToken === false ? {} : { pairingToken: "PAIRTOKEN123" }),
    expiresAt: "2026-09-03T20:05:21.215Z",
  });

const gateway = (environmentId: EnvironmentId = ENVIRONMENT_ID) =>
  TailcatEnvironmentGateway.of({
    provision: ({ payload, connectionId }) =>
      Effect.succeed({
        environmentId,
        label: "GPU box",
        bootstrap: {
          connectionId,
          address: payload.address,
          remotePort: payload.port,
          localPort: 48831,
          httpBaseUrl: "http://127.0.0.1:48831",
          wsBaseUrl: "ws://127.0.0.1:48831",
          clientNodeKey: NODE_KEY,
        },
        bearerToken: "bearer-token",
      }),
    prepare: () => Effect.die("unused"),
    disconnect: () => Effect.die("unused"),
  });

describe("tailcat onboarding", () => {
  it.effect("registers the logical Tailcat endpoint, never the local forward port", () =>
    Effect.gen(function* () {
      const registration = yield* prepareTailcatRegistration({ code: code() }).pipe(
        Effect.provideService(TailcatEnvironmentGateway, gateway()),
      );

      expect(registration).toMatchObject({
        _tag: "TailcatConnectionRegistration",
        target: {
          _tag: "TailcatConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "GPU box",
          connectionId: `tailcat:${ENVIRONMENT_ID}`,
        },
        profile: {
          _tag: "TailcatConnectionProfile",
          connectionId: `tailcat:${ENVIRONMENT_ID}`,
          address: ADDRESS,
          remotePort: 47831,
        },
        credential: { _tag: "BearerConnectionCredential", token: "bearer-token" },
      });
      expect(Object.values(registration.profile)).not.toContain(48831);
    }),
  );

  it.effect("prefers an explicit label over the descriptor label", () =>
    Effect.gen(function* () {
      const registration = yield* prepareTailcatRegistration({
        code: code(),
        label: "  Office box ",
      }).pipe(Effect.provideService(TailcatEnvironmentGateway, gateway()));
      expect(registration.target.label).toBe("Office box");
    }),
  );

  it.effect("refuses a code whose environment differs from the machine that answered", () =>
    Effect.gen(function* () {
      const result = yield* prepareTailcatRegistration({ code: code() }).pipe(
        Effect.provideService(
          TailcatEnvironmentGateway,
          gateway(EnvironmentId.make("environment-other")),
        ),
        Effect.flip,
      );
      expect(result).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
    }),
  );

  it.effect("refuses a code without a pairing credential before opening a tunnel", () =>
    Effect.gen(function* () {
      let provisioned = false;
      const result = yield* prepareTailcatRegistration({
        code: code({ withPairingToken: false }),
      }).pipe(
        Effect.provideService(
          TailcatEnvironmentGateway,
          TailcatEnvironmentGateway.of({
            provision: () =>
              Effect.sync(() => {
                provisioned = true;
              }).pipe(Effect.andThen(Effect.die("unreachable"))),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
        Effect.flip,
      );
      expect(result).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
      });
      expect(provisioned).toBe(false);
    }),
  );

  it.effect("explains an invalid or foreign code", () =>
    Effect.gen(function* () {
      const notACode = yield* prepareTailcatRegistration({ code: "https://example.com/pair" }).pipe(
        Effect.provideService(TailcatEnvironmentGateway, gateway()),
        Effect.flip,
      );
      expect(notACode).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });

      const peerCode = yield* prepareTailcatRegistration({ code: "t3c://peer/eyJ2IjoxfQ" }).pipe(
        Effect.provideService(TailcatEnvironmentGateway, gateway()),
        Effect.flip,
      );
      expect(peerCode).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(peerCode.detail).toMatch(/peer|Tailcat connection code/iu);
    }),
  );
});

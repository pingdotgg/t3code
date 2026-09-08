import * as railway from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const missingSession = ["RailwayNotFound", "NotFound"] as const;

test.provider(
  "create, verify, and cancel a login session",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const code = yield* Railway.provideAnonymousRailway(
        railway.loginSessionCreate({}),
      );
      expect(code).toEqual(expect.any(String));
      expect(code.length).toBeGreaterThan(0);

      const url = Railway.loginSessionUrl(code, { hostname: "alchemy-test" });
      expect(url.startsWith("https://railway.com/cli-login?d=")).toBe(true);
      const encoded = url.slice("https://railway.com/cli-login?d=".length);
      const payload = Buffer.from(
        encoded.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8");
      expect(payload).toContain(`wordCode=${code}`);
      expect(payload).toContain("hostname=alchemy-test");

      const verified = yield* Railway.provideAnonymousRailway(
        railway
          .loginSessionVerify({ code })
          .pipe(Effect.catchTag(missingSession, () => Effect.succeed(false))),
      );
      // Verify is a liveness check: true while the pairing session exists,
      // even before the user authorizes in the browser.
      expect(verified).toBe(true);

      const beforeAuth = yield* Railway.provideAnonymousRailway(
        railway
          .loginSessionConsume({ code })
          .pipe(Effect.catchTag(missingSession, () => Effect.succeed(null))),
      );
      expect(beforeAuth).toBeNull();

      const cancelled = yield* Railway.provideAnonymousRailway(
        railway.loginSessionCancel({ code }),
      );
      expect(cancelled).toBe(true);

      const cancelledAgain = yield* Railway.provideAnonymousRailway(
        railway
          .loginSessionCancel({ code })
          .pipe(Effect.catchTag(missingSession, () => Effect.succeed(false))),
      );
      expect(typeof cancelledAgain).toBe("boolean");

      const verifiedAfter = yield* Railway.provideAnonymousRailway(
        railway
          .loginSessionVerify({ code })
          .pipe(Effect.catchTag(missingSession, () => Effect.succeed(false))),
      );
      expect(verifiedAfter).toBe(false);

      const consumedAfter = yield* Railway.provideAnonymousRailway(
        railway
          .loginSessionConsume({ code })
          .pipe(Effect.catchTag(missingSession, () => Effect.succeed(null))),
      );
      expect(consumedAfter).toBeNull();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

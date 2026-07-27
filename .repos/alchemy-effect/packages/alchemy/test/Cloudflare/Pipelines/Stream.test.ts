import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the harness mints propagates eventually-consistently
// across Cloudflare's edge — ride out mid-deploy 403 blips.
const retryAuthBlip = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.retry({
      while: (e) => String(e).includes("Unable to authenticate request"),
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  );

test.provider(
  "list enumerates the deployed pipeline stream",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* retryAuthBlip(
        stack.deploy(Cloudflare.Pipelines.Stream("ListStream", {})),
      );
      expect(deployed.streamId).toBeTruthy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Pipelines.Stream,
      );
      const all = yield* provider.list();

      // Exhaustively-paginated result contains the deployed stream, hydrated
      // into the exact `read` Attributes shape.
      const found = all.find((s) => s.streamId === deployed.streamId);
      expect(found).toBeTruthy();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.name).toEqual(deployed.name);
      expect(found?.httpEnabled).toEqual(deployed.httpEnabled);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

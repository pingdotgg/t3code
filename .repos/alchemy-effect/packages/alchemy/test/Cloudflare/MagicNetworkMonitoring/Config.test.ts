import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The MNM config is an account singleton served from an eventually-consistent
// store: an immediate `list()` right after a create (or a destroy) can still
// observe the prior state, so the freshly-created config reads back as absent
// (`[]`) for a beat. Poll `list()` until the element count settles to the
// expected value before asserting on it (bounded ~30s).
const listUntilCount = <A>(
  list: () => Effect.Effect<A[], unknown>,
  expected: number,
) =>
  list().pipe(
    Effect.flatMap((all) =>
      all.length === expected
        ? Effect.succeed(all)
        : Effect.fail(
            new Error(`expected ${expected} MNM configs, got ${all.length}`),
          ),
    ),
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("500 millis"),
        Schedule.spaced("3 seconds"),
      ]),
      times: 12,
    }),
  );

describe.sequential("MagicNetworkMonitoring.Config list", () => {
  test.provider("list enumerates the account MNM config", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        // The config is an account singleton with no ownership markers, so a
        // leftover from an interrupted run surfaces as `Unowned`. Adopt it
        // rather than failing with `OwnedBySomeoneElse` or racing an
        // out-of-band delete against the singleton's eventual consistency.
        Cloudflare.MagicNetworkMonitoring.Config("Config", {
          name: "alchemy-mnm-list-test",
          defaultSampling: 1,
        }).pipe(adopt(true)),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicNetworkMonitoring.Config,
      );
      // Account singleton: when present, exactly one element with the full
      // Attributes shape (the same object `read` returns). Poll through the
      // create's read-after-write lag.
      const all = yield* listUntilCount(() => provider.list(), 1);

      expect(all.length).toEqual(1);
      const config = all[0];
      expect(config.accountId).toEqual(accountId);
      expect(config.name).toEqual(deployed.name);
      expect(config.defaultSampling).toEqual(deployed.defaultSampling);
      expect(config.routerIps).toEqual([]);
      expect(config.warpDevices).toEqual([]);

      yield* stack.destroy();

      // With the singleton unset, `list` returns the empty array, not a throw.
      // Poll through the destroy's read-after-write lag.
      const afterDestroy = yield* listUntilCount(() => provider.list(), 0);
      expect(afterDestroy).toEqual([]);
    }).pipe(logLevel),
  );
});

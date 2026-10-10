import type { FlyMachineConfig } from "@distilled.cloud/fly-io/machines";
import { deploymentPolicy, validateDeployment } from "@/Fly/Deployment";
import {
  predecessorShutdown,
  sameChecks,
  sameServices,
  toFlyService,
  toFlyServiceCheck,
} from "@/Fly/replicas";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

it.effect(
  "deployment defaults preserve existing behavior",
  () =>
    Effect.gen(function* () {
      const rolling = yield* deploymentPolicy(undefined, undefined);
      expect(rolling.bluegreen).toBe(false);
      expect(rolling.shutdown).toBeUndefined();
      const bluegreen = yield* deploymentPolicy(
        { strategy: "bluegreen" },
        undefined,
      );
      expect(bluegreen.healthTimeoutMs).toBe(60_000);
      expect(bluegreen.shutdown).toEqual({
        signal: "SIGTERM",
        timeout: "30000ms",
        timeoutMs: 30_000,
      });
    }),
  { tags: ["unit", "provider:fly", "provider:fly:service", "local"] },
);

it.effect(
  "service intervals honor Fly's one-minute cap without capping named checks",
  () =>
    Effect.sync(() => {
      for (const [requested, effective] of [
        ["75s", "60s"],
        ["1m15s", "60s"],
        ["60s", "60s"],
        ["59.999s", "59.999s"],
      ] as const) {
        const check = { type: "http" as const, port: 80, interval: requested };
        expect(
          toFlyService({ protocol: "tcp", internalPort: 80, checks: [check] })
            .checks?.[0]?.interval,
        ).toBe(effective);
        expect(toFlyServiceCheck(check).interval).toBe(requested);
      }
    }),
  { tags: ["unit", "provider:fly", "provider:fly:service", "local"] },
);

it.effect(
  "check durations compare exactly at nanosecond precision",
  () =>
    Effect.sync(() => {
      const cases: Array<[string | undefined, string | undefined, boolean]> = [
        ["1001ms", "1.001s", true],
        ["1001ms", "1.001000001s", false],
        ["65s", "1m5s", true],
        ["1.s", ".5s500ms", true],
        ["1us", "1µs", true],
        ["1μs", "1000ns", true],
        ["+1.001s", "1001ms", true],
        ["-1.001s", "-1001ms", true],
        ["-1ns", "1ns", false],
        ["0", "0s", true],
        ["-0", "+0s", true],
        ["0.9ns0.9ns", "0ns", true],
        ["9007199254740992ns", "9007199254740993ns", false],
        ["9223372036854775807ns", "9223372036.854775807s", true],
        ["-9223372036854775808ns", "-9223372036.854775808s", true],
        ["9223372036854775808ns", "9223372036.854775808s", false],
        ["-9223372036854775809ns", "-9223372036.854775809s", false],
        ["9223372036854775807ns1ns", "9223372036.854775808s", false],
        ["999999999999999999999999h", "999999999999999999999999h0s", false],
        ["1e3ms", "1s", false],
        ["1s1e3ms", "2s", false],
        ["1d", "24h", false],
        ["1s ", "1s", false],
        ["1s!", "1s?", false],
        ["--1s", "1s", false],
        ["1s-1s", "0s", false],
        ["1", "1ns", false],
        ["", "0s", false],
        [undefined, "0s", false],
      ];
      for (const field of ["interval", "grace_period", "timeout"] as const) {
        for (const [observed, desired, equal] of cases) {
          const left = { type: "http", port: 80, path: "/", [field]: observed };
          const right = { type: "http", port: 80, path: "/", [field]: desired };
          expect(sameChecks({ ready: left }, { ready: right })).toBe(equal);
          expect(
            sameServices(
              [{ internal_port: 80, checks: [left] }],
              [{ internal_port: 80, checks: [right] }],
            ),
          ).toBe(equal);
        }
      }
    }),
  { tags: ["unit", "provider:fly", "provider:fly:service", "local"] },
);

it.effect(
  "exact duration parsing preserves shutdown policy validation",
  () =>
    Effect.gen(function* () {
      const policy = yield* predecessorShutdown({
        config: {
          stop_config: { timeout: "1.001s" },
          env: { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "1001" },
        },
      });
      expect(policy.timeoutMs).toBe(1001);
      for (const timeout of ["0", "0s", "-1s", "+1s", "300.000000001s"]) {
        const error = yield* predecessorShutdown({
          config: { stop_config: { timeout } },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("Fly.ShutdownPolicyMismatch");
      }
    }),
  { tags: ["unit", "provider:fly", "provider:fly:service", "local"] },
);

for (const timeout of [0, -1, 300_001, Infinity, 0.1]) {
  it.effect(
    `rejects invalid shutdown duration ${timeout}`,
    () =>
      Effect.gen(function* () {
        const error = yield* deploymentPolicy(undefined, { timeout }).pipe(
          Effect.flip,
        );
        expect(error._tag).toBe("Fly.InvalidDeployment");
      }),
    { tags: ["unit", "provider:fly", "provider:fly:service", "local"] },
  );
}

it.effect(
  "S10 S11 rejects unsupported bluegreen configuration before mutation",
  () =>
    Effect.gen(function* () {
      const policy = yield* deploymentPolicy(
        { strategy: "bluegreen" },
        undefined,
      );
      const checks = { ready: { type: "http", port: 80, path: "/" } };
      const cases: Array<[FlyMachineConfig, boolean, boolean]> = [
        [{}, false, false],
        [{ checks }, true, false],
        [{ checks }, false, true],
        [{ checks, auto_destroy: true }, false, false],
        [{ checks, restart: { policy: "no" } }, false, false],
        [{ checks, services: [{ ports: [{ port: 80 }] }] }, false, false],
      ];
      for (const [config, mounted, skip] of cases) {
        const error = yield* validateDeployment(
          policy,
          config,
          mounted,
          skip,
        ).pipe(Effect.flip);
        expect(error._tag).toBe("Fly.InvalidDeployment");
      }
      const signal = yield* deploymentPolicy(
        undefined,
        { signal: "SIGQUIT" },
        true,
      ).pipe(Effect.flip);
      expect(signal._tag).toBe("Fly.InvalidDeployment");
    }),
  {
    tags: [
      "unit",
      "provider:fly",
      "provider:fly:machine",
      "provider:fly:service",
      "local",
    ],
  },
);

it.effect(
  "S06 R05 accepts the finite 300-second boundary without a live sleep",
  () =>
    Effect.gen(function* () {
      const policy = yield* deploymentPolicy(
        { strategy: "bluegreen", healthTimeout: 300_000 },
        { timeout: 300_000 },
      );
      expect(policy.healthTimeoutMs).toBe(300_000);
      expect(policy.shutdown?.timeoutMs).toBe(300_000);
      for (const healthTimeout of [0, -1, 300_001, Infinity, NaN, 0.1]) {
        const error = yield* deploymentPolicy(
          { strategy: "bluegreen", healthTimeout },
          undefined,
        ).pipe(Effect.flip);
        expect(error._tag).toBe("Fly.InvalidDeployment");
      }
    }),
  { tags: ["unit", "provider:fly", "provider:fly:service", "local"] },
);

for (const autostop of ["stop", "suspend"] as const) {
  it.effect(
    `S11 accepts ${autostop} instead of silently rejecting idle capacity`,
    () =>
      Effect.gen(function* () {
        const policy = yield* deploymentPolicy(
          { strategy: "bluegreen" },
          undefined,
        );
        yield* validateDeployment(
          policy,
          {
            services: [
              {
                internal_port: 80,
                ports: [{ port: 80 }],
                checks: [{ type: "http", port: 80, path: "/" }],
                autostop,
                autostart: true,
                min_machines_running: 1,
              },
            ],
          },
          false,
        );
      }),
    { tags: ["unit", "provider:fly", "provider:fly:service", "local"] },
  );
}

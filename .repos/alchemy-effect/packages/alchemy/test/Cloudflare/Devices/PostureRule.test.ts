import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getRule = (accountId: string, ruleId: string) =>
  zeroTrust.getDevicePosture({ accountId, ruleId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, ruleId: string) =>
  getRule(accountId, ruleId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "RuleNotDeleted" } as const)),
    // A missing rule surfaces as `PostureRuleNotFound` (Cloudflare error
    // code 6024) — that's the success condition here.
    Effect.catchTag("PostureRuleNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RuleNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create, update in place, and delete a posture rule", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const rule = yield* stack.deploy(
      Cloudflare.Devices.DevicePostureRule("WindowsOsVersion", {
        name: "alchemy-test-posture-os",
        type: "os_version",
        description: "Require Windows 10.0.19045+",
        match: [{ platform: "windows" }],
        schedule: "5m",
        input: {
          operatingSystem: "windows",
          operator: ">=",
          version: "10.0.19045",
        },
      }),
    );

    expect(rule.postureRuleId).toBeTruthy();
    expect(rule.accountId).toEqual(accountId);
    expect(rule.name).toEqual("alchemy-test-posture-os");
    expect(rule.type).toEqual("os_version");
    expect(rule.description).toEqual("Require Windows 10.0.19045+");

    // Out-of-band verify against the live API.
    const live = yield* getRule(accountId, rule.postureRuleId);
    expect(live.name).toEqual("alchemy-test-posture-os");
    expect(live.type).toEqual("os_version");

    // Update mutable props in place — same rule id.
    const updated = yield* stack.deploy(
      Cloudflare.Devices.DevicePostureRule("WindowsOsVersion", {
        name: "alchemy-test-posture-os",
        type: "os_version",
        description: "Require Windows 10.0.22631+",
        match: [{ platform: "windows" }],
        schedule: "10m",
        input: {
          operatingSystem: "windows",
          operator: ">=",
          version: "10.0.22631",
        },
      }),
    );
    expect(updated.postureRuleId).toEqual(rule.postureRuleId);
    expect(updated.description).toEqual("Require Windows 10.0.22631+");
    expect(updated.schedule).toEqual("10m");

    const live2 = yield* getRule(accountId, rule.postureRuleId);
    expect(live2.description).toEqual("Require Windows 10.0.22631+");
    expect(live2.schedule).toEqual("10m");

    yield* stack.destroy();
    yield* expectGone(accountId, rule.postureRuleId);
  }).pipe(logLevel),
);

test.provider("changing the rule type triggers a replacement", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const original = yield* stack.deploy(
      Cloudflare.Devices.DevicePostureRule("Replace", {
        name: "alchemy-test-posture-replace",
        type: "firewall",
        match: [{ platform: "mac" }],
        schedule: "5m",
        input: { enabled: true, operatingSystem: "mac" },
      }),
    );
    expect(original.type).toEqual("firewall");

    // `type` is immutable — diff must request a replacement.
    const replaced = yield* stack.deploy(
      Cloudflare.Devices.DevicePostureRule("Replace", {
        name: "alchemy-test-posture-replace",
        type: "disk_encryption",
        match: [{ platform: "mac" }],
        schedule: "5m",
        input: { requireAll: true },
      }),
    );
    expect(replaced.type).toEqual("disk_encryption");
    expect(replaced.postureRuleId).not.toEqual(original.postureRuleId);

    // The old rule must be gone after the replacement completes.
    yield* expectGone(accountId, original.postureRuleId);

    yield* stack.destroy();
    yield* expectGone(accountId, replaced.postureRuleId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed posture rule", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Devices.DevicePostureRule("ListRule", {
        name: "alchemy-test-posture-list",
        type: "os_version",
        match: [{ platform: "windows" }],
        schedule: "5m",
        input: {
          operatingSystem: "windows",
          operator: ">=",
          version: "10.0.19045",
        },
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Devices.DevicePostureRule,
    );
    const all = yield* provider.list();

    // Exhaustive pagination must include the rule we just deployed.
    expect(
      all.some((rule) => rule.postureRuleId === deployed.postureRuleId),
    ).toBe(true);

    yield* stack.destroy();
    yield* expectGone(accountId, deployed.postureRuleId);
  }).pipe(logLevel),
);

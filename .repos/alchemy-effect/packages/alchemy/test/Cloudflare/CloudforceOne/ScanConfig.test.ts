import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudforceOne from "@distilled.cloud/cloudflare/cloudforce-one";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloudforce One attack-surface scans are entitlement-gated: on the standard
// testing account every `/cloudforce-one/scans/config` call fails with the
// typed `Unauthorized` error ("needs cfone.port_scan entitlement"). The full
// lifecycle test below is gated behind an explicit opt-in env flag for
// entitled accounts; the probe test always runs and pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_CLOUDFORCE_ONE;

// Probe once per suite: either the account can list scan configs (entitled)
// or the call fails with the typed `Unauthorized` tag.
const probeEntitlement = (accountId: string) =>
  cloudforceOne.listScanConfigs({ accountId }).pipe(
    Effect.as(true),
    Effect.catchTag("Unauthorized", () => Effect.succeed(false)),
  );

// Unentitlement probe — pins the typed Unauthorized rejection ("needs cfone.port_scan
// entitlement") and skips on entitled accounts, where the API would accept the calls.
test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed Unauthorized error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* probeEntitlement(accountId);
      if (canList) {
        // Entitled account — nothing to assert here; the lifecycle test
        // covers the real behavior.
        yield* Effect.logInfo(
          "account is cloudforce-one entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const listError = yield* cloudforceOne
        .listScanConfigs({ accountId })
        .pipe(Effect.flip);
      expect(listError._tag).toEqual("Unauthorized");
      expect(listError.message).toContain("cfone.port_scan");

      const createError = yield* cloudforceOne
        .createScanConfig({ accountId, ips: ["1.1.1.1/32"], frequency: 0 })
        .pipe(Effect.flip);
      expect(createError._tag).toEqual("Unauthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Poll the account list until the config id disappears — there is no
// get-by-id endpoint, so "gone" means absent from the list.
const expectGone = (accountId: string, configId: string) =>
  cloudforceOne.listScanConfigs({ accountId }).pipe(
    Effect.flatMap((page) =>
      page.result.some((c) => c.id === configId)
        ? Effect.fail({ _tag: "ScanConfigNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "ScanConfigNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Requires the Cloudforce One attack-surface scan (cfone.port_scan) entitlement —
// unentitled accounts fail with the typed Unauthorized. Unlock with CLOUDFLARE_TEST_CLOUDFORCE_ONE=1.
test.provider.skipIf(!entitled)(
  "create a scan config, update ports in place, delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — one-off scan of a single documentation address.
      const created = yield* stack.deploy(
        Cloudflare.CloudforceOne.ScanConfig("TestScanConfig", {
          ips: ["1.1.1.1/32"],
          frequency: 0,
        }),
      );
      expect(created.configId).toBeTruthy();
      expect(created.accountId).toEqual(accountId);
      expect(created.ips).toEqual(["1.1.1.1/32"]);
      expect(created.frequency).toEqual(0);

      // Out-of-band verification — the config shows up in the account list.
      const listed = yield* cloudforceOne.listScanConfigs({ accountId });
      expect(listed.result.map((c) => c.id)).toContain(created.configId);

      // In-place update — change the port list; the config id is stable.
      const updated = yield* stack.deploy(
        Cloudflare.CloudforceOne.ScanConfig("TestScanConfig", {
          ips: ["1.1.1.1/32"],
          frequency: 0,
          ports: ["1-80", "443"],
        }),
      );
      expect(updated.configId).toEqual(created.configId);
      expect([...updated.ports].sort()).toEqual(["1-80", "443"]);

      // No-op redeploy — same props, same config id.
      const noop = yield* stack.deploy(
        Cloudflare.CloudforceOne.ScanConfig("TestScanConfig", {
          ips: ["1.1.1.1/32"],
          frequency: 0,
          ports: ["1-80", "443"],
        }),
      );
      expect(noop.configId).toEqual(created.configId);

      yield* stack.destroy();

      yield* expectGone(accountId, created.configId);

      // Destroy again — delete is idempotent (typed ScanConfigNotFound).
      yield* stack.destroy();
    }).pipe(logLevel),
);

// Read-only list assertion — always runs. On unentitled accounts the provider's
// list() catches the typed `Unauthorized` (needs cfone.port_scan) and returns
// [], so this stays green everywhere.
test.provider("list returns an array of scan configs", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.CloudforceOne.ScanConfig,
    );
    const all = yield* provider.list();
    expect(Array.isArray(all)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

// Full enumeration — gated on the cfone.port_scan entitlement. Unlock with
// CLOUDFLARE_TEST_CLOUDFORCE_ONE=1. Unentitled accounts surface the typed
// Unauthorized on the deploy (createScanConfig), so the mutation is gated.
test.provider.skipIf(!entitled)(
  "list enumerates the deployed scan config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.CloudforceOne.ScanConfig("ListScanConfig", {
          ips: ["1.1.1.1/32"],
          frequency: 0,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.CloudforceOne.ScanConfig,
      );
      const all = yield* provider.list();
      expect(all.some((c) => c.configId === deployed.configId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

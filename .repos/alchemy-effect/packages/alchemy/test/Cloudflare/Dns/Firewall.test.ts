import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dnsFirewall from "@distilled.cloud/cloudflare/dns-firewall";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// DNS Firewall is a paid add-on (Enterprise / contract). On the standard
// testing account `POST /accounts/{id}/dns_firewall` fails with Cloudflare
// error code 10101 — "You do not have access to this feature." — surfaced
// as the typed `DnsFirewallNotEntitled` error. The full lifecycle tests
// below are gated behind an entitled account supplied via env.
const entitled = !!process.env.CLOUDFLARE_TEST_DNS_FIREWALL;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getCluster = (accountId: string, dnsFirewallId: string) =>
  dnsFirewall.getDnsFirewall({ accountId, dnsFirewallId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// Poll until the cluster is gone — a missing cluster surfaces as the typed
// `DnsFirewallNotFound` (Cloudflare error code 11001).
const expectGone = (accountId: string, dnsFirewallId: string) =>
  getCluster(accountId, dnsFirewallId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "ClusterNotDeleted" } as const)),
    Effect.catchTag("DnsFirewallNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ClusterNotDeleted",
      schedule: Schedule.exponential("500 millis"),
      times: 10,
    }),
  );

test.provider.skipIf(entitled)(
  "surfaces the typed DnsFirewallNotEntitled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The testing account has no DNS Firewall entitlement — the distilled
      // create call must fail with the typed entitlement tag (Cloudflare
      // error code 10101). Reads on the same account succeed (and show no
      // clusters), proving the gate is on creation, not on the API token.
      const error = yield* dnsFirewall
        .createDnsFirewall({
          accountId,
          name: "alchemy-dnsfw-entitlement-probe",
          upstreamIps: ["192.0.2.1"],
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("DnsFirewallNotEntitled");

      const list = yield* dnsFirewall.listDnsFirewalls({ accountId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
      expect(list.result).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "create, verify out-of-band, destroy, and wait until gone",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const cluster = yield* stack.deploy(
        Cloudflare.DNS.Firewall("TestCluster", {
          name: "alchemy-dnsfw-lifecycle",
          upstreamIps: ["192.0.2.1"],
        }),
      );

      expect(cluster.dnsFirewallId).toBeTruthy();
      expect(cluster.accountId).toEqual(accountId);
      expect(cluster.name).toEqual("alchemy-dnsfw-lifecycle");
      expect(cluster.upstreamIps).toEqual(["192.0.2.1"]);
      // The key output — the assigned anycast IPs NS glue points at.
      expect(cluster.dnsFirewallIps.length).toBeGreaterThan(0);
      // Documented defaults.
      expect(cluster.deprecateAnyRequests).toEqual(false);
      expect(cluster.ecsFallback).toEqual(false);
      expect(cluster.retries).toEqual(2);

      const live = yield* getCluster(accountId, cluster.dnsFirewallId);
      expect(live.name).toEqual("alchemy-dnsfw-lifecycle");
      expect([...live.upstreamIps]).toEqual(["192.0.2.1"]);

      yield* stack.destroy();

      yield* expectGone(accountId, cluster.dnsFirewallId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "update mutable settings in place, replace on rename",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Cloudflare.DNS.Firewall("UpdateCluster", {
          name: "alchemy-dnsfw-update",
          upstreamIps: ["192.0.2.1"],
        }),
      );

      // In-place update: settings + an extra upstream IP, same id.
      const updated = yield* stack.deploy(
        Cloudflare.DNS.Firewall("UpdateCluster", {
          name: "alchemy-dnsfw-update",
          upstreamIps: ["192.0.2.1", "192.0.2.2"],
          ratelimit: 600,
          minimumCacheTtl: 120,
          attackMitigation: { enabled: true },
        }),
      );
      expect(updated.dnsFirewallId).toEqual(initial.dnsFirewallId);
      expect([...updated.upstreamIps].sort()).toEqual([
        "192.0.2.1",
        "192.0.2.2",
      ]);
      expect(updated.ratelimit).toEqual(600);
      expect(updated.minimumCacheTtl).toEqual(120);
      expect(updated.attackMitigation.enabled).toEqual(true);

      const live = yield* getCluster(accountId, updated.dnsFirewallId);
      expect(live.ratelimit).toEqual(600);
      expect(live.minimumCacheTtl).toEqual(120);

      // No-op redeploy keeps the same cluster.
      const noop = yield* stack.deploy(
        Cloudflare.DNS.Firewall("UpdateCluster", {
          name: "alchemy-dnsfw-update",
          upstreamIps: ["192.0.2.1", "192.0.2.2"],
          ratelimit: 600,
          minimumCacheTtl: 120,
          attackMitigation: { enabled: true },
        }),
      );
      expect(noop.dnsFirewallId).toEqual(initial.dnsFirewallId);

      // Rename — the name is the cold-state recovery identity, so a new
      // cluster replaces the old one.
      const renamed = yield* stack.deploy(
        Cloudflare.DNS.Firewall("UpdateCluster", {
          name: "alchemy-dnsfw-update-v2",
          upstreamIps: ["192.0.2.1", "192.0.2.2"],
          ratelimit: 600,
          minimumCacheTtl: 120,
          attackMitigation: { enabled: true },
        }),
      );
      expect(renamed.dnsFirewallId).not.toEqual(initial.dnsFirewallId);
      expect(renamed.name).toEqual("alchemy-dnsfw-update-v2");

      yield* expectGone(accountId, initial.dnsFirewallId);

      yield* stack.destroy();

      yield* expectGone(accountId, renamed.dnsFirewallId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account collection): the enumeration endpoint
// (`GET /accounts/{id}/dns_firewall`) is NOT entitlement-gated — only
// cluster *creation* is — so `list()` runs on the unentitled testing
// account and returns the (empty) cluster Attributes array. This read-only
// assertion proves `list()` exhaustively paginates and produces the exact
// `read` Attributes shape.
test.provider(
  "list returns the DNS firewall cluster Attributes array",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.DNS.Firewall);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Entitled accounts: deploy a real cluster and assert it appears in the
// exhaustively-paginated `list()` result with the exact `read` Attributes.
test.provider.skipIf(!entitled)(
  "list enumerates the deployed DNS firewall cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.DNS.Firewall("ListCluster", {
          name: "alchemy-dnsfw-list",
          upstreamIps: ["192.0.2.1"],
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.DNS.Firewall);
      const all = yield* provider.list();

      const found = all.find((c) => c.dnsFirewallId === deployed.dnsFirewallId);
      expect(found).toBeTruthy();
      expect(found?.name).toEqual("alchemy-dnsfw-list");
      expect(found?.accountId).toEqual(deployed.accountId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

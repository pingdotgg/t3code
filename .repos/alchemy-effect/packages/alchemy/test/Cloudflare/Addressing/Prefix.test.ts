import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as addressing from "@distilled.cloud/cloudflare/addressing";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const retryForbidden = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const resolveAccountId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return accountId;
});

// BYOIP prefixes can only be onboarded through a Cloudflare contract process
// (LOA upload, IRR/RPKI validation, manual approval), so the full lifecycle
// tests are gated behind env vars pointing at a BYOIP-entitled account:
//   CLOUDFLARE_TEST_BYOIP_CIDR          — a CIDR onboardable by the account
//   CLOUDFLARE_TEST_BYOIP_ASN           — the ASN to advertise under
//   CLOUDFLARE_TEST_BYOIP_PREFIX_ID     — an existing approved prefix id
//   CLOUDFLARE_TEST_BYOIP_DELEGATE_ACCOUNT_ID — second account for delegations
const byoipCidr = process.env.CLOUDFLARE_TEST_BYOIP_CIDR;
const byoipAsn = process.env.CLOUDFLARE_TEST_BYOIP_ASN;
const byoipPrefixId = process.env.CLOUDFLARE_TEST_BYOIP_PREFIX_ID;
const delegateAccountId = process.env.CLOUDFLARE_TEST_BYOIP_DELEGATE_ACCOUNT_ID;

// The read-only catalog endpoints are available regardless of the BYOIP
// entitlement — exercise the distilled wiring live on every run.
test.provider("lists the services catalog and prefixes (read-only)", (stack) =>
  Effect.gen(function* () {
    const accountId = yield* resolveAccountId;

    yield* stack.destroy();

    const services = yield* retryForbidden(
      addressing.listServices.items({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((c) => Array.from(c)),
      ),
    );
    expect(Array.isArray(services)).toBe(true);

    const prefixes = yield* retryForbidden(
      addressing.listPrefixes.items({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((c) => Array.from(c)),
      ),
    );
    expect(Array.isArray(prefixes)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

// `list()` enumerates account-scoped BYOIP prefixes via the catalog endpoint,
// which is available regardless of the BYOIP entitlement (it returns an empty
// array on accounts with no onboarded prefixes). The result is a well-typed
// `PrefixAttributes[]` — the exact shape `read` produces.
test.provider("list enumerates account prefixes (read-only)", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Cloudflare.Addressing.Prefix);
    const all = yield* retryForbidden(provider.list());

    expect(Array.isArray(all)).toBe(true);
    for (const p of all) {
      expect(typeof p.prefixId).toBe("string");
      expect(typeof p.accountId).toBe("string");
      expect(typeof p.cidr).toBe("string");
      expect(typeof p.asn).toBe("number");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!byoipCidr || !byoipAsn)(
  "prefix: create, patch description in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;
      const cidr = byoipCidr!;
      const asn = Number(byoipAsn!);

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.Prefix("Byoip", {
            cidr,
            asn,
            description: "alchemy v1",
            delegateLoaCreation: true,
          });
        }),
      );
      expect(created.prefixId).toBeDefined();
      expect(created.cidr).toEqual(cidr);
      expect(created.asn).toEqual(asn);
      expect(created.description).toEqual("alchemy v1");

      // Out-of-band verification.
      const live = yield* retryForbidden(
        addressing.getPrefix({ accountId, prefixId: created.prefixId }),
      );
      expect(live.cidr).toEqual(cidr);
      expect(live.description).toEqual("alchemy v1");

      // Update the description in place — same physical prefix.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.Prefix("Byoip", {
            cidr,
            asn,
            description: "alchemy v2",
            delegateLoaCreation: true,
          });
        }),
      );
      expect(updated.prefixId).toEqual(created.prefixId);
      expect(updated.description).toEqual("alchemy v2");

      // Destroy and verify gone via the typed not-found read.
      yield* stack.destroy();
      const gone = yield* retryForbidden(
        addressing.getPrefix({ accountId, prefixId: created.prefixId }),
      ).pipe(
        Effect.catchTag("PrefixNotFound", () => Effect.succeed(undefined)),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!byoipPrefixId)(
  "bgp prefix: adopt-or-create by cidr, toggle advertisement, withdraw on destroy",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;
      const prefixId = byoipPrefixId!;

      const prefix = yield* retryForbidden(
        addressing.getPrefix({ accountId, prefixId }),
      );
      const cidr = prefix.cidr!;

      yield* stack.destroy();

      // Cloudflare auto-creates BGP prefixes during onboarding — the
      // resource adopts the one matching the CIDR rather than duplicating.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.BgpPrefix("Bgp", {
            prefixId,
            cidr,
            advertised: false,
          });
        }),
      );
      expect(created.bgpPrefixId).toBeDefined();
      expect(created.cidr).toEqual(cidr);
      expect(created.onDemand.advertised).toEqual(false);

      // Advertise in place — same BGP prefix; propagation is eventually
      // consistent so only the API acknowledgement is asserted.
      const advertised = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.BgpPrefix("Bgp", {
            prefixId,
            cidr,
            advertised: true,
          });
        }),
      );
      expect(advertised.bgpPrefixId).toEqual(created.bgpPrefixId);
      expect(advertised.onDemand.advertised).toEqual(true);

      // Destroy withdraws the advertisement (no delete API exists).
      yield* stack.destroy();
      const after = yield* retryForbidden(
        addressing.getPrefixBgpPrefix({
          accountId,
          prefixId,
          bgpPrefixId: created.bgpPrefixId,
        }),
      );
      expect(after.onDemand?.advertised ?? false).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!byoipPrefixId || !delegateAccountId)(
  "prefix delegation: create and destroy (replace-only resource)",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;
      const prefixId = byoipPrefixId!;

      const prefix = yield* retryForbidden(
        addressing.getPrefix({ accountId, prefixId }),
      );
      const cidr = prefix.cidr!;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.PrefixDelegation("Share", {
            prefixId,
            cidr,
            delegatedAccountId: delegateAccountId!,
          });
        }),
      );
      expect(created.delegationId).toBeDefined();
      expect(created.cidr).toEqual(cidr);
      expect(created.delegatedAccountId).toEqual(delegateAccountId);

      // Out-of-band verification via the list endpoint (no get op).
      const delegations = yield* retryForbidden(
        addressing.listPrefixDelegations.items({ accountId, prefixId }).pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c)),
        ),
      );
      expect(delegations.some((d) => d.id === created.delegationId)).toBe(true);

      yield* stack.destroy();
      const after = yield* retryForbidden(
        addressing.listPrefixDelegations.items({ accountId, prefixId }).pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c)),
        ),
      );
      expect(after.some((d) => d.id === created.delegationId)).toBe(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!byoipPrefixId)(
  "service binding: create against the CDN service and destroy",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;
      const prefixId = byoipPrefixId!;

      const prefix = yield* retryForbidden(
        addressing.getPrefix({ accountId, prefixId }),
      );
      const cidr = prefix.cidr!;

      const services = yield* retryForbidden(
        addressing.listServices.items({ accountId }).pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c)),
        ),
      );
      const cdn = services.find((s) => s.name === "CDN") ?? services[0];
      expect(cdn?.id).toBeDefined();

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.ServiceBinding("Cdn", {
            prefixId,
            cidr,
            serviceId: cdn!.id!,
          });
        }),
      );
      expect(created.bindingId).toBeDefined();
      expect(created.serviceId).toEqual(cdn!.id);
      // Provisioning to the edge is asynchronous.
      expect(["provisioning", "active"]).toContain(
        created.provisioning.state ?? "provisioning",
      );

      // Out-of-band verification.
      const live = yield* retryForbidden(
        addressing.getPrefixServiceBinding({
          accountId,
          prefixId,
          bindingId: created.bindingId,
        }),
      );
      expect(live.cidr).toEqual(cidr);

      yield* stack.destroy();
      const gone = yield* retryForbidden(
        addressing.getPrefixServiceBinding({
          accountId,
          prefixId,
          bindingId: created.bindingId,
        }),
      ).pipe(
        Effect.catchTag(["BindingNotFound", "PrefixNotFound"], () =>
          Effect.succeed(undefined),
        ),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

import { resolve4, Resolver } from "node:dns/promises";
/**
 * The DNS adapter contract (`alchemy/DNS`) against its three built-in hosts.
 *
 * Every test deploys a real stack whose program resolves an adapter with
 * `DNS.resolve(config)` and calls its functions (`alias`, `aliasSet`,
 * `records`), then verifies the published records out-of-band through the
 * host's distilled SDK and — for the Route 53 sub-zone (delegated from the
 * Cloudflare test zone) and the Hetzner zone — by querying the zone's
 * authoritative nameservers directly.
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Hetzner from "@alchemy.run/hetzner";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as cfdns from "@distilled.cloud/cloudflare/dns";
import * as HetznerErrors from "@distilled.cloud/hetzner";
import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as hetznerZones from "@distilled.cloud/hetzner/zones";
import * as DNS from "alchemy/DNS";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers(), Hetzner.providers()),
});

// A stack WITHOUT the Hetzner (or AWS) host registered.
const cloudflareOnly = Test.make({ providers: Cloudflare.providers() });

const CF_ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const TARGET_1 = "example.net";
const TARGET_2 = "example.org";
const TXT_1 = "dns-adapter=v1";
const TXT_2 = "dns-adapter=v2";

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type RecordType = "A" | "AAAA" | "CNAME" | "TXT";

/** Lowercase, no trailing dot, TXT unquoted. */
const normalize = (value: string) => value.replace(/^"|"$/g, "").replace(/\.$/, "").toLowerCase();

const sorted = (values: readonly string[]) => [...values].map(normalize).sort();

const resolveCloudflareZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: CF_ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${CF_ZONE}" not found`));
  }
  return zone.id;
});

/** Cloudflare records at `(name, type)` (the harness's fresh token may 403 briefly). */
const cloudflareRecords = (zoneId: string, name: string, type: RecordType | "NS") =>
  cfdns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.filter((r) => normalize(r.name) === name && r.type === type),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const cloudflareValues = (zoneId: string, name: string, type: RecordType) =>
  cloudflareRecords(zoneId, name, type).pipe(
    Effect.map((records) => sorted(records.map((r) => r.content ?? ""))),
  );

/**
 * Delegate `name` from the standing Cloudflare zone to a sub-zone's
 * nameservers — one `NS` record per nameserver.
 */
const delegate = <Req>(
  cfZoneId: string,
  name: string,
  nameServers: Output.Output<string[], Req>,
  count: number,
) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) =>
      Cloudflare.DNS.Record(`Delegation${index + 1}`, {
        zoneId: cfZoneId,
        name,
        type: "NS",
        content: Output.map(nameServers, (servers) => normalize(servers[index]!)),
      }),
  );

class DnsQueryFailed extends Data.TaggedError("DnsQueryFailed")<{
  readonly code: string;
  readonly server: string;
  readonly name: string;
}> {}

class AnswerMismatch extends Data.TaggedError("AnswerMismatch")<{
  readonly server: string;
  readonly name: string;
  readonly type: RecordType;
  readonly answer: string[];
  readonly expected: string[];
}> {}

/** IPv4 addresses of a zone's nameservers. */
const nameServerAddresses = (nameServers: readonly string[]) =>
  Effect.forEach(nameServers, (ns) =>
    Effect.tryPromise(() => resolve4(normalize(ns))).pipe(
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
      Effect.orDie,
    ),
  ).pipe(Effect.map((addresses) => addresses.flat()));

/** One non-recursive-style query against a single authoritative server. */
const queryServer = (server: string, name: string, type: RecordType) =>
  Effect.gen(function* () {
    const resolver = yield* Effect.sync(() => {
      const r = new Resolver({ timeout: 3_000, tries: 1 });
      r.setServers([server]);
      return r;
    });
    const answer = yield* Effect.tryPromise({
      try: (): Promise<string[] | string[][]> =>
        type === "A"
          ? resolver.resolve4(name)
          : type === "AAAA"
            ? resolver.resolve6(name)
            : type === "CNAME"
              ? resolver.resolveCname(name)
              : resolver.resolveTxt(name),
      catch: (error) =>
        new DnsQueryFailed({
          code: error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN",
          server,
          name,
        }),
    }).pipe(
      // No record (or no name) is an answer: the empty set.
      Effect.catchIf(
        (e) => e.code === "ENODATA" || e.code === "ENOTFOUND",
        () => Effect.succeed([] as string[]),
      ),
    );
    return sorted(answer.map((v) => (Array.isArray(v) ? v.join("") : v)));
  });

/**
 * Wait until EVERY authoritative server answers `(name, type)` with exactly
 * `expected` (the empty list = no such record).
 */
const waitForAuthoritative = (
  servers: readonly string[],
  name: string,
  type: RecordType,
  expected: readonly string[],
) =>
  Effect.forEach(
    servers,
    (server) =>
      queryServer(server, name, type).pipe(
        Effect.flatMap((answer) =>
          JSON.stringify(answer) === JSON.stringify(sorted(expected))
            ? Effect.void
            : Effect.fail(
                new AnswerMismatch({
                  server,
                  name,
                  type,
                  answer,
                  expected: sorted(expected),
                }),
              ),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 30 }),
      ),
    { concurrency: "unbounded", discard: true },
  );

/** The value of type `T` a deploy died (or failed) with, if any. */
const failureOf = <A, E, R, T>(
  deploy: Effect.Effect<A, E, R>,
  cls: abstract new (...args: never[]) => T,
) =>
  deploy.pipe(
    Effect.as(undefined),
    Effect.catchCause((cause) =>
      Effect.succeed(
        cause.reasons
          .map((reason) =>
            Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : undefined,
          )
          .find((value): value is T => value instanceof cls),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

const CF = {
  cname: `dns-adapter-cname.${CF_ZONE}`,
  addresses: `dns-adapter-addr.${CF_ZONE}`,
  proxied: `dns-adapter-proxied.${CF_ZONE}`,
  setA: `dns-adapter-set-a.${CF_ZONE}`,
  setB: `dns-adapter-set-b.${CF_ZONE}`,
  txt: `dns-adapter-txt.${CF_ZONE}`,
  recordCname: `dns-adapter-rec-cname.${CF_ZONE}`,
};

const cloudflareProgram = (version: 1 | 2) =>
  Effect.gen(function* () {
    const dns = yield* DNS.resolve(Cloudflare.DNS.Adapter({ zone: CF_ZONE }));
    const proxied = yield* DNS.resolve(Cloudflare.DNS.Adapter({ zone: CF_ZONE, proxied: true }));
    const target = version === 1 ? TARGET_1 : TARGET_2;

    yield* dns.alias("Cname", { name: CF.cname, target: { hostname: target } });
    yield* dns.alias("Addresses", {
      name: CF.addresses,
      target:
        version === 1 ? { ipv4: ["192.0.2.10"], ipv6: ["2001:db8::10"] } : { ipv4: ["192.0.2.11"] },
    });
    yield* proxied.alias("Proxied", {
      name: CF.proxied,
      target: { hostname: TARGET_1 },
    });
    const set = yield* dns.aliasSet("Set", {
      names: version === 1 ? [CF.setA] : [],
      target: { hostname: target },
    });
    yield* set.bind`BoundSite`({ names: [CF.setB] });
    yield* dns.records("Records", {
      records:
        version === 1
          ? [
              { name: CF.txt, type: "TXT", value: TXT_1 },
              { name: CF.recordCname, type: "CNAME", value: TARGET_1 },
            ]
          : [{ name: CF.txt, type: "TXT", value: TXT_2 }],
    });
  });

describe("Cloudflare.DNS adapter", () => {
  test.provider(
    "alias, aliasSet (+ bound names) and records converge in Cloudflare",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveCloudflareZoneId;
        yield* stack.destroy();

        yield* stack.deploy(cloudflareProgram(1));

        const cname = yield* cloudflareRecords(zoneId, CF.cname, "CNAME");
        expect(sorted(cname.map((r) => r.content ?? ""))).toEqual([TARGET_1]);
        expect(cname[0]?.proxied).toBe(false);
        expect(yield* cloudflareValues(zoneId, CF.addresses, "A")).toEqual(["192.0.2.10"]);
        expect(yield* cloudflareValues(zoneId, CF.addresses, "AAAA")).toEqual(["2001:db8::10"]);
        const proxiedCname = yield* cloudflareRecords(zoneId, CF.proxied, "CNAME");
        expect(proxiedCname).toHaveLength(1);
        expect(proxiedCname[0]?.proxied).toBe(true);
        for (const name of [CF.setA, CF.setB]) {
          const [record, ...extra] = yield* cloudflareRecords(zoneId, name, "CNAME");
          expect(extra).toHaveLength(0);
          expect(normalize(record?.content ?? "")).toBe(TARGET_1);
          expect(record?.proxied).toBe(false);
        }
        expect(yield* cloudflareValues(zoneId, CF.txt, "TXT")).toEqual([TXT_1]);
        const recordCname = yield* cloudflareRecords(zoneId, CF.recordCname, "CNAME");
        expect(sorted(recordCname.map((r) => r.content ?? ""))).toEqual([TARGET_1]);
        expect(recordCname[0]?.proxied).toBe(false);

        // Change targets, drop a declared set name, an address and a record.
        yield* stack.deploy(cloudflareProgram(2));

        expect(yield* cloudflareValues(zoneId, CF.cname, "CNAME")).toEqual([TARGET_2]);
        expect(yield* cloudflareValues(zoneId, CF.addresses, "A")).toEqual(["192.0.2.11"]);
        expect(yield* cloudflareValues(zoneId, CF.addresses, "AAAA")).toEqual([]);
        expect(yield* cloudflareValues(zoneId, CF.setA, "CNAME")).toEqual([]);
        expect(yield* cloudflareValues(zoneId, CF.setB, "CNAME")).toEqual([TARGET_2]);
        expect(yield* cloudflareValues(zoneId, CF.txt, "TXT")).toEqual([TXT_2]);
        expect(yield* cloudflareValues(zoneId, CF.recordCname, "CNAME")).toEqual([]);

        yield* stack.destroy();

        for (const name of Object.values(CF)) {
          for (const type of ["A", "AAAA", "CNAME", "TXT"] as const) {
            expect(yield* cloudflareValues(zoneId, name, type)).toEqual([]);
          }
        }
      }),
    {
      tags: ["provider:dns", "provider:cloudflare:dns", "live"],
      timeout: 180_000,
    },
  );
});

// ---------------------------------------------------------------------------
// Route 53 — a hosted zone delegated from the Cloudflare test zone
// ---------------------------------------------------------------------------

const R53_ZONE = `dns-adapter-r53.${CF_ZONE}`;
const R53 = {
  origin: `origin.${R53_ZONE}`,
  www: `www.${R53_ZONE}`,
  cname: `cname.${R53_ZONE}`,
  setA: `set-a.${R53_ZONE}`,
  setB: `set-b.${R53_ZONE}`,
  txt: `txt.${R53_ZONE}`,
  recordCname: `rec-cname.${R53_ZONE}`,
};

const route53Program = (cfZoneId: string, version: 1 | 2) =>
  Effect.gen(function* () {
    const zone = yield* AWS.Route53.HostedZone("Zone", { name: R53_ZONE });
    yield* delegate(cfZoneId, R53_ZONE, zone.nameServers, 4);

    const dns = yield* DNS.resolve(AWS.Route53.Adapter({ hostedZoneId: zone.id }));
    const target = version === 1 ? TARGET_1 : TARGET_2;

    // An address target: the Route 53 adapter declares an
    // `AWS.Route53.RecordList`, which is also the alias target below.
    const origin = (yield* dns.alias("Origin", {
      name: R53.origin,
      target: {
        ipv4: [version === 1 ? "192.0.2.20" : "192.0.2.21"],
        ipv6: ["2001:db8::20"],
      },
    })) as AWS.Route53.RecordList;

    // A dual-stack Route 53 alias at a record in the same zone — a real
    // AWS alias target that needs no billable resource.
    yield* dns.alias("Www", {
      name: R53.www,
      ipv6: true,
      target: {
        hostname: Output.map(origin.records, () => R53.origin),
        route53Alias: { hostedZoneId: zone.id, evaluateTargetHealth: false },
      },
    });
    yield* dns.alias("Cname", {
      name: R53.cname,
      target: { hostname: target },
    });
    const set = yield* dns.aliasSet("Set", {
      names: version === 1 ? [R53.setA] : [],
      target: { hostname: target },
    });
    yield* set.bind`BoundSite`({ names: [R53.setB] });
    yield* dns.records("Records", {
      records:
        version === 1
          ? [
              { name: R53.txt, type: "TXT", value: TXT_1 },
              { name: R53.recordCname, type: "CNAME", value: TARGET_1 },
            ]
          : [{ name: R53.txt, type: "TXT", value: TXT_2 }],
    });
    return zone;
  });

/** The simple record set `(name, type)` in a hosted zone, if any. */
const route53Set = (hostedZoneId: string, name: string, type: RecordType) =>
  route53
    .listResourceRecordSets({
      HostedZoneId: hostedZoneId,
      StartRecordName: `${name}.`,
      StartRecordType: type,
      MaxItems: 1,
    })
    .pipe(
      Effect.map((response) =>
        (response.ResourceRecordSets ?? []).find(
          (set) => normalize(set.Name) === name && set.Type === type,
        ),
      ),
    );

const route53Values = (hostedZoneId: string, name: string, type: RecordType) =>
  route53Set(hostedZoneId, name, type).pipe(
    Effect.map((set) => sorted((set?.ResourceRecords ?? []).map((r) => r.Value))),
  );

const waitUntilHostedZoneGone = (hostedZoneId: string) =>
  route53.getHostedZone({ Id: hostedZoneId }).pipe(
    Effect.as("present" as const),
    Effect.catchTag("NoSuchHostedZone", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

describe("AWS.Route53 adapter", () => {
  test.provider(
    "alias (Route 53 alias, CNAME, addresses), aliasSet and records converge in a delegated hosted zone",
    (stack) =>
      Effect.gen(function* () {
        const cfZoneId = yield* resolveCloudflareZoneId;
        yield* stack.destroy();

        const zone = yield* stack.deploy(route53Program(cfZoneId, 1));
        const zoneId = zone.id;

        // Publicly delegated from the Cloudflare zone.
        expect(
          sorted((yield* cloudflareRecords(cfZoneId, R53_ZONE, "NS")).map((r) => r.content ?? "")),
        ).toEqual(sorted(zone.nameServers));

        // Route 53 state.
        const www = yield* route53Set(zoneId, R53.www, "A");
        expect(normalize(www?.AliasTarget?.DNSName ?? "")).toBe(R53.origin);
        expect(www?.AliasTarget?.HostedZoneId).toBe(zoneId);
        expect(
          normalize((yield* route53Set(zoneId, R53.www, "AAAA"))?.AliasTarget?.DNSName ?? ""),
        ).toBe(R53.origin);
        expect(yield* route53Values(zoneId, R53.origin, "A")).toEqual(["192.0.2.20"]);
        expect(yield* route53Values(zoneId, R53.origin, "AAAA")).toEqual(["2001:db8::20"]);
        for (const name of [R53.cname, R53.setA, R53.setB, R53.recordCname]) {
          expect(yield* route53Values(zoneId, name, "CNAME")).toEqual([TARGET_1]);
        }
        expect(yield* route53Values(zoneId, R53.txt, "TXT")).toEqual([TXT_1]);

        // Authoritative answers from the zone's own nameservers.
        const servers = yield* nameServerAddresses(zone.nameServers);
        yield* waitForAuthoritative(servers, R53.www, "A", ["192.0.2.20"]);
        yield* waitForAuthoritative(servers, R53.www, "AAAA", ["2001:db8::20"]);
        yield* waitForAuthoritative(servers, R53.cname, "CNAME", [TARGET_1]);
        yield* waitForAuthoritative(servers, R53.setB, "CNAME", [TARGET_1]);
        yield* waitForAuthoritative(servers, R53.txt, "TXT", [TXT_1]);

        // Change targets and addresses, drop a declared set name and a record.
        yield* stack.deploy(route53Program(cfZoneId, 2));

        expect(yield* route53Values(zoneId, R53.origin, "A")).toEqual(["192.0.2.21"]);
        expect(yield* route53Values(zoneId, R53.cname, "CNAME")).toEqual([TARGET_2]);
        expect(yield* route53Values(zoneId, R53.setA, "CNAME")).toEqual([]);
        expect(yield* route53Values(zoneId, R53.setB, "CNAME")).toEqual([TARGET_2]);
        expect(yield* route53Values(zoneId, R53.txt, "TXT")).toEqual([TXT_2]);
        expect(yield* route53Values(zoneId, R53.recordCname, "CNAME")).toEqual([]);
        // The alias follows its target's new address.
        yield* waitForAuthoritative(servers, R53.www, "A", ["192.0.2.21"]);
        yield* waitForAuthoritative(servers, R53.cname, "CNAME", [TARGET_2]);
        yield* waitForAuthoritative(servers, R53.setA, "CNAME", []);
        yield* waitForAuthoritative(servers, R53.txt, "TXT", [TXT_2]);
        yield* waitForAuthoritative(servers, R53.recordCname, "CNAME", []);

        yield* stack.destroy();

        expect(yield* waitUntilHostedZoneGone(zoneId)).toBe("gone");
        expect(yield* cloudflareRecords(cfZoneId, R53_ZONE, "NS")).toEqual([]);
      }),
    {
      tags: ["provider:dns", "provider:aws:route53", "live"],
      timeout: 360_000,
    },
  );
});

// ---------------------------------------------------------------------------
// Hetzner — Hetzner DNS only hosts registrable domains (a sub-zone such as
// `dns-adapter-hz.alchemy-test-2.us` is rejected with `unsupported tld`, see
// the probe below), so the zone can't be delegated from the Cloudflare test
// zone. Hetzner's authoritative nameservers answer for every zone they host,
// delegated or not, so the records are verified against them directly.
// ---------------------------------------------------------------------------

const HZ_SUBZONE = `dns-adapter-hz.${CF_ZONE}`;
const HZ_ZONE = "dns-adapter-hz-alchemy-test.us";
const HZ = {
  cname: `cname.${HZ_ZONE}`,
  addresses: `addr.${HZ_ZONE}`,
  setA: `set-a.${HZ_ZONE}`,
  setB: `set-b.${HZ_ZONE}`,
  txt: `txt.${HZ_ZONE}`,
  recordCname: `rec-cname.${HZ_ZONE}`,
};

const hetznerProgram = (version: 1 | 2) =>
  Effect.gen(function* () {
    const zone = yield* Hetzner.Zone("Zone", { name: HZ_ZONE, ttl: 60 });
    const dns = yield* DNS.resolve(Hetzner.DNS.Adapter({ zone }));
    const target = version === 1 ? TARGET_1 : TARGET_2;

    yield* dns.alias("Cname", { name: HZ.cname, target: { hostname: target } });
    yield* dns.alias("Addresses", {
      name: HZ.addresses,
      target:
        version === 1 ? { ipv4: ["192.0.2.30"], ipv6: ["2001:db8::30"] } : { ipv4: ["192.0.2.31"] },
    });
    const set = yield* dns.aliasSet("Set", {
      names: version === 1 ? [HZ.setA] : [],
      target: { hostname: target },
    });
    yield* set.bind`BoundSite`({ names: [HZ.setB] });
    yield* dns.records("Records", {
      records:
        version === 1
          ? [
              { name: HZ.txt, type: "TXT", value: TXT_1 },
              { name: HZ.recordCname, type: "CNAME", value: TARGET_1 },
            ]
          : [{ name: HZ.txt, type: "TXT", value: TXT_2 }],
    });
    return zone;
  });

/** Live values of the RRSet `(name, type)`, normalized and sorted. */
const hetznerValues = (zoneId: number, name: string, type: RecordType) =>
  zoneRrsets
    .getZoneRrset({
      id_or_name: String(zoneId),
      rr_name: name === HZ_ZONE ? "@" : name.slice(0, -(HZ_ZONE.length + 1)),
      rr_type: type,
    })
    .pipe(
      Effect.map(({ rrset }) => sorted(rrset.records.map((r) => r.value))),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const waitUntilHetznerZoneGone = (zoneId: number) =>
  hetznerZones.getZone({ id_or_name: String(zoneId) }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

describe("Hetzner.DNS adapter", () => {
  test.provider.skipIf(!hasHetznerCreds)(
    "alias, aliasSet (+ bound names) and records converge in a Hetzner zone",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const zone = yield* stack.deploy(hetznerProgram(1));
        const zoneId = zone.zoneId;

        expect(yield* hetznerValues(zoneId, HZ.cname, "CNAME")).toEqual([TARGET_1]);
        expect(yield* hetznerValues(zoneId, HZ.addresses, "A")).toEqual(["192.0.2.30"]);
        expect(yield* hetznerValues(zoneId, HZ.addresses, "AAAA")).toEqual(["2001:db8::30"]);
        for (const name of [HZ.setA, HZ.setB, HZ.recordCname]) {
          expect(yield* hetznerValues(zoneId, name, "CNAME")).toEqual([TARGET_1]);
        }
        expect(yield* hetznerValues(zoneId, HZ.txt, "TXT")).toEqual([TXT_1]);

        const servers = yield* nameServerAddresses(zone.assignedNameservers);
        yield* waitForAuthoritative(servers, HZ.cname, "CNAME", [TARGET_1]);
        yield* waitForAuthoritative(servers, HZ.addresses, "A", ["192.0.2.30"]);
        yield* waitForAuthoritative(servers, HZ.setB, "CNAME", [TARGET_1]);
        yield* waitForAuthoritative(servers, HZ.txt, "TXT", [TXT_1]);

        yield* stack.deploy(hetznerProgram(2));

        expect(yield* hetznerValues(zoneId, HZ.cname, "CNAME")).toEqual([TARGET_2]);
        expect(yield* hetznerValues(zoneId, HZ.addresses, "A")).toEqual(["192.0.2.31"]);
        expect(yield* hetznerValues(zoneId, HZ.addresses, "AAAA")).toEqual([]);
        expect(yield* hetznerValues(zoneId, HZ.setA, "CNAME")).toEqual([]);
        expect(yield* hetznerValues(zoneId, HZ.setB, "CNAME")).toEqual([TARGET_2]);
        expect(yield* hetznerValues(zoneId, HZ.txt, "TXT")).toEqual([TXT_2]);
        expect(yield* hetznerValues(zoneId, HZ.recordCname, "CNAME")).toEqual([]);
        yield* waitForAuthoritative(servers, HZ.cname, "CNAME", [TARGET_2]);
        yield* waitForAuthoritative(servers, HZ.addresses, "A", ["192.0.2.31"]);
        yield* waitForAuthoritative(servers, HZ.setA, "CNAME", []);
        yield* waitForAuthoritative(servers, HZ.txt, "TXT", [TXT_2]);

        yield* stack.destroy();

        expect(yield* waitUntilHetznerZoneGone(zoneId)).toBe("gone");
      }),
    {
      tags: ["provider:dns", "provider:hetzner:dns", "live"],
      timeout: 300_000,
    },
  );

  test.provider.skipIf(!hasHetznerCreds)(
    "a CNAME alias at the pinned zone apex dies with DnsAdapterError",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const alias = yield* failureOf(
          stack.deploy(
            Effect.gen(function* () {
              const dns = yield* DNS.resolve(Hetzner.DNS.Adapter({ zone: HZ_ZONE }));
              yield* dns.alias("Apex", {
                name: `${HZ_ZONE.toUpperCase()}.`,
                target: { hostname: TARGET_1 },
              });
            }),
          ),
          DNS.DnsAdapterError,
        );
        expect(alias).toBeInstanceOf(DNS.DnsAdapterError);
        expect(alias?.message).toContain("zone apex");

        const aliasSet = yield* failureOf(
          stack.deploy(
            Effect.gen(function* () {
              const dns = yield* DNS.resolve(Hetzner.DNS.Adapter({ zone: HZ_ZONE }));
              yield* dns.aliasSet("Set", {
                names: [`www.${HZ_ZONE}`, HZ_ZONE],
                target: { hostname: TARGET_1 },
              });
            }),
          ),
          DNS.DnsAdapterError,
        );
        expect(aliasSet).toBeInstanceOf(DNS.DnsAdapterError);

        yield* stack.destroy();
      }),
    { tags: ["provider:dns", "provider:hetzner:dns", "live"] },
  );

  test.provider.skipIf(!hasHetznerCreds)(
    "Hetzner DNS rejects a sub-zone of the Cloudflare test zone (why the zone is not delegated)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const failure = yield* failureOf(
          stack.deploy(Hetzner.Zone("SubZone", { name: HZ_SUBZONE })),
          HetznerErrors.UnprocessableEntity,
        );
        expect(failure).toBeInstanceOf(HetznerErrors.UnprocessableEntity);
        expect(failure?.message).toContain("unsupported tld");

        yield* stack.destroy();
      }),
    { tags: ["provider:dns", "provider:hetzner:dns", "live"] },
  );
});

// ---------------------------------------------------------------------------
// Unregistered DNS hosts
// ---------------------------------------------------------------------------

describe("DNS.resolve", () => {
  cloudflareOnly.test.provider(
    "a deploy naming a DNS host whose providers() are not in the stack dies with DnsAdapterNotRegistered",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const failure = yield* failureOf(
          stack.deploy(
            Effect.gen(function* () {
              const dns = yield* DNS.resolve(Hetzner.DNS.Adapter({ zone: HZ_ZONE }));
              yield* dns.records("Records", {
                records: [{ name: HZ.txt, type: "TXT", value: TXT_1 }],
              });
            }),
          ),
          DNS.DnsAdapterNotRegistered,
        );
        expect(failure).toBeInstanceOf(DNS.DnsAdapterNotRegistered);
        expect(failure?.type).toBe("Hetzner.DNS");
        expect(failure?.message).toContain("Hetzner.providers()");

        yield* stack.destroy();
      }),
    { tags: ["provider:dns", "live"] },
  );

  test.provider(
    "a deploy naming an unknown DNS host type dies with DnsAdapterNotRegistered",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const failure = yield* failureOf(
          stack.deploy(
            Effect.gen(function* () {
              const dns = yield* DNS.resolve({ type: "Nope.DNS" });
              yield* dns.records("Records", {
                records: [{ name: CF.txt, type: "TXT", value: TXT_1 }],
              });
            }),
          ),
          DNS.DnsAdapterNotRegistered,
        );
        expect(failure?.type).toBe("Nope.DNS");
        expect(failure?.message).toContain("Nope.providers()");

        yield* stack.destroy();
      }),
    { tags: ["provider:dns", "live"] },
  );
});

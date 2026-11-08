/**
 * ACM certificate validation through DNS adapters, live.
 *
 * - `Certificate({ dnsValidation: "external" })` → the adapter's retained
 *   validation records → `AWS.ACM.CertificateValidation`, published in
 *   Cloudflare and in a Route 53 zone delegated from the Cloudflare test
 *   zone.
 * - The Route 53 default: `Certificate({ hostedZoneId })` validates inline.
 *
 * Skipped under --fast: ACM issuance takes minutes.
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { withProviders } from "@alchemy.run/test/Core";
import * as acm from "@distilled.cloud/aws/acm";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Alchemy from "alchemy";
import * as DNS from "alchemy/DNS";
import * as Output from "alchemy/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const providers = Layer.mergeAll(AWS.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
});

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
/** Validated through the Cloudflare zone. */
const CF_DOMAIN = `acm-dns-cf.${zoneName}`;
/** Route 53 zone delegated from the Cloudflare zone. */
const R53_ZONE = `acm-dns-r53.${zoneName}`;
/** Validated inline by the Route 53 default path. */
const INLINE_DOMAIN = `inline.${R53_ZONE}`;

const skipSlow = !!process.env.FAST;

const tags = [
  "provider:aws",
  "provider:aws:acm",
  "provider:aws:route53",
  "provider:cloudflare",
  "provider:cloudflare:dns",
  "live",
];

const normalize = (name: string) => name.replace(/\.$/, "").toLowerCase();

// Certificates default to us-east-1 (CloudFront's region).
const withUsEast1 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const describeCertificate = (certificateArn: string) =>
  withUsEast1(
    acm
      .describeCertificate({ CertificateArn: certificateArn })
      .pipe(Effect.map((response) => response.Certificate)),
  );

const waitForCertificateGone = (certificateArn: string) =>
  withUsEast1(
    acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
      Effect.as("present" as const),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    ),
  );

/** Distinct validation CNAMEs ACM asks for (one per name, deduped). */
const distinctValidationRecords = (options: acm.DomainValidation[] | undefined) => [
  ...new Map(
    (options ?? []).flatMap((option) =>
      option.ResourceRecord ? [[normalize(option.ResourceRecord.Name), option.ResourceRecord]] : [],
    ),
  ).values(),
];

const lookupParentZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
  }
  return zone.id;
});

const cloudflareRecords = (zoneId: string, name: string, type: "CNAME" | "NS") =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).filter((record) => normalize(record.name) === name && record.type === type),
    ),
  );

/** Route 53 CNAME record sets at `name`. */
const route53Cnames = (hostedZoneId: string, name: string) =>
  route53
    .listResourceRecordSets({
      HostedZoneId: hostedZoneId,
      StartRecordName: `${name}.`,
      StartRecordType: "CNAME",
      MaxItems: 1,
    })
    .pipe(
      Effect.map((response) =>
        (response.ResourceRecordSets ?? []).filter(
          (set) => normalize(set.Name) === name && set.Type === "CNAME",
        ),
      ),
    );

/**
 * Exactly one validation CNAME per distinct name exists in Route 53,
 * pointing at ACM's value.
 */
const expectRoute53ValidationRecords = (
  hostedZoneId: string,
  options: acm.DomainValidation[] | undefined,
) =>
  Effect.forEach(distinctValidationRecords(options), (record) =>
    Effect.gen(function* () {
      const sets = yield* route53Cnames(hostedZoneId, normalize(record.Name));
      expect(sets).toHaveLength(1);
      expect((sets[0]!.ResourceRecords ?? []).map((r) => normalize(r.Value))).toEqual([
        normalize(record.Value),
      ]);
    }),
  );

describe.skipIf(skipSlow)("ACM validation through Cloudflare DNS (live)", { tags }, () => {
  test.provider(
    "an external-validated wildcard + apex certificate publishes one CNAME in Cloudflare and reaches ISSUED",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const zoneId = yield* lookupParentZoneId;

        const [elapsed, deployed] = yield* stack
          .deploy(
            Effect.gen(function* () {
              const cert = yield* AWS.ACM.Certificate("Cert", {
                domainName: CF_DOMAIN,
                subjectAlternativeNames: [`*.${CF_DOMAIN}`],
                dnsValidation: "external",
              });
              const adapter = yield* DNS.resolve(Cloudflare.DNS.Adapter({ zone: zoneName }));
              yield* adapter.records("CertValidation", {
                records: Output.map(cert.domainValidationOptions, AWS.ACM.validationRecordsOf),
                retain: true,
              });
              const issued = yield* AWS.ACM.CertificateValidation("CertIssued", {
                certificateArn: cert.certificateArn,
              });
              return {
                certificateArn: issued.certificateArn,
                status: issued.status,
              };
            }),
          )
          .pipe(Effect.timed);
        yield* Effect.logInfo(`ACM via Cloudflare DNS: issued in ${Duration.format(elapsed)}`);
        expect(deployed.status).toBe("ISSUED");

        const described = yield* describeCertificate(deployed.certificateArn);
        expect(described?.Status).toBe("ISSUED");
        // Apex + wildcard: two validations sharing one CNAME name.
        expect(described?.DomainValidationOptions).toHaveLength(2);
        const records = distinctValidationRecords(described?.DomainValidationOptions);
        expect(records).toHaveLength(1);
        expect(AWS.ACM.validationRecordsOf(described?.DomainValidationOptions)).toHaveLength(1);

        // Exactly one DNS-only CNAME per distinct name in Cloudflare.
        for (const record of records) {
          const cnames = yield* cloudflareRecords(zoneId, normalize(record.Name), "CNAME");
          expect(cnames).toHaveLength(1);
          expect(normalize(cnames[0]!.content ?? "")).toBe(normalize(record.Value));
          expect(cnames[0]!.proxied).toBe(false);
        }

        yield* stack.destroy();

        expect(yield* waitForCertificateGone(deployed.certificateArn)).toBe("gone");

        // The validation CNAMEs are retained (ACM reuses one per name
        // across certificates). Remove this test's copies.
        for (const record of records) {
          const retained = yield* cloudflareRecords(zoneId, normalize(record.Name), "CNAME");
          expect(retained).toHaveLength(1);
          yield* Effect.forEach(retained, (r) => dns.deleteRecord({ zoneId, dnsRecordId: r.id }), {
            discard: true,
          });
        }
      }),
    { timeout: 900_000 },
  );
});

describe.skipIf(skipSlow)(
  "ACM validation through a delegated Route 53 zone (live)",
  { tags },
  () => {
    const parentZoneId = beforeAll(
      withProviders(lookupParentZoneId, { providers }, "AcmDnsR53Delegation"),
    );

    // A Route 53 zone the internet resolves: delegated from the Cloudflare
    // test zone with one NS record per Route 53 nameserver.
    const Delegation = Alchemy.Stack(
      "AcmDnsR53Delegation",
      { providers, state: Alchemy.localState() },
      Effect.gen(function* () {
        const zoneId = yield* parentZoneId;
        const zone = yield* AWS.Route53.HostedZone("Zone", {
          name: R53_ZONE,
          // Removes the retained validation CNAMEs with the zone.
          forceDestroy: true,
        });
        // Route 53 always assigns four nameservers.
        yield* Effect.forEach([0, 1, 2, 3], (index) =>
          Cloudflare.DNS.Record(`Delegation${index}`, {
            zoneId,
            name: R53_ZONE,
            type: "NS",
            content: Output.map(zone.nameServers, (nameServers) => nameServers[index]!),
          }),
        );
        return { hostedZoneId: zone.id, nameServers: zone.nameServers };
      }),
    );

    const delegated = beforeAll(deploy(Delegation), { timeout: 300_000 });

    afterAll.skipIf(!!process.env.NO_DESTROY)(
      Effect.gen(function* () {
        const zone = yield* delegated;
        const zoneId = yield* parentZoneId;
        yield* destroy(Delegation);
        if (zone === undefined || zoneId === undefined) return;
        yield* withProviders(
          Effect.gen(function* () {
            const status = yield* route53.getHostedZone({ Id: zone.hostedZoneId }).pipe(
              Effect.as("present" as const),
              Effect.catchTag("NoSuchHostedZone", () => Effect.succeed("gone" as const)),
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (s) => s === "gone",
                times: 10,
              }),
            );
            expect(status).toBe("gone");
            expect(yield* cloudflareRecords(zoneId, R53_ZONE, "NS")).toHaveLength(0);
          }),
          { providers },
          "AcmDnsR53Delegation",
        );
      }),
      { timeout: 300_000 },
    );

    test.provider(
      "an external-validated certificate publishes its CNAME through the Route 53 adapter and reaches ISSUED",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { hostedZoneId, nameServers } = yield* delegated;
          const zoneId = yield* parentZoneId;

          // The delegation is live in Cloudflare.
          const ns = yield* cloudflareRecords(zoneId, R53_ZONE, "NS");
          expect(ns.map((r) => normalize(r.content ?? "")).sort()).toEqual(
            nameServers.map(normalize).sort(),
          );

          const [elapsed, deployed] = yield* stack
            .deploy(
              Effect.gen(function* () {
                const cert = yield* AWS.ACM.Certificate("Cert", {
                  domainName: R53_ZONE,
                  subjectAlternativeNames: [`*.${R53_ZONE}`],
                  dnsValidation: "external",
                });
                const adapter = yield* DNS.resolve(AWS.Route53.Adapter({ hostedZoneId }));
                yield* adapter.records("CertValidation", {
                  records: Output.map(cert.domainValidationOptions, AWS.ACM.validationRecordsOf),
                  retain: true,
                });
                const issued = yield* AWS.ACM.CertificateValidation("CertIssued", {
                  certificateArn: cert.certificateArn,
                });
                return {
                  certificateArn: issued.certificateArn,
                  status: issued.status,
                };
              }),
            )
            .pipe(Effect.timed);
          yield* Effect.logInfo(`ACM via Route 53 adapter: issued in ${Duration.format(elapsed)}`);
          expect(deployed.status).toBe("ISSUED");

          const described = yield* describeCertificate(deployed.certificateArn);
          expect(described?.Status).toBe("ISSUED");
          expect(described?.DomainValidationOptions).toHaveLength(2);
          expect(distinctValidationRecords(described?.DomainValidationOptions)).toHaveLength(1);
          yield* expectRoute53ValidationRecords(hostedZoneId, described?.DomainValidationOptions);

          yield* stack.destroy();

          expect(yield* waitForCertificateGone(deployed.certificateArn)).toBe("gone");
          // Retained: the zone's `forceDestroy` removes them with the zone.
          yield* expectRoute53ValidationRecords(hostedZoneId, described?.DomainValidationOptions);
        }),
      { timeout: 900_000 },
    );

    test.provider(
      "the Route 53 default validates inline and reaches ISSUED",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { hostedZoneId } = yield* delegated;

          const [elapsed, deployed] = yield* stack
            .deploy(
              Effect.gen(function* () {
                const cert = yield* AWS.ACM.Certificate("Cert", {
                  domainName: INLINE_DOMAIN,
                  hostedZoneId,
                });
                return {
                  certificateArn: cert.certificateArn,
                  status: cert.status,
                  hostedZoneId: cert.hostedZoneId,
                };
              }),
            )
            .pipe(Effect.timed);
          yield* Effect.logInfo(
            `ACM inline Route 53 validation: issued in ${Duration.format(elapsed)}`,
          );
          expect(deployed.status).toBe("ISSUED");
          expect(deployed.hostedZoneId).toBe(hostedZoneId);

          const described = yield* describeCertificate(deployed.certificateArn);
          expect(described?.Status).toBe("ISSUED");
          yield* expectRoute53ValidationRecords(hostedZoneId, described?.DomainValidationOptions);

          yield* stack.destroy();

          expect(yield* waitForCertificateGone(deployed.certificateArn)).toBe("gone");
        }),
      { timeout: 900_000 },
    );
  },
);

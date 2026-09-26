/**
 * Wave 3 — Site→Router hostname binding.
 *
 * A router-attached site's `domain: { name, router }` declaration alone must
 * be sufficient for the hostname to be fully provisioned: the site binds its
 * concrete hostnames onto the Router's distribution (alias), managed
 * certificate (SAN — replacement on change), and Route 53 record set.
 *
 * The ungated tests compile real compositions (no cloud calls — resource
 * registration only) and assert on the binding rows the engine collects,
 * which is exactly what the providers receive in `reconcile` and what the
 * planner diffs (`diffBindings` plans an update whenever a row changes).
 *
 * The live suite is gated behind AWS_TEST_HOSTED_ZONE=<zone-name> because it
 * needs a real Route 53 hosted zone (the shared testing account has none).
 */
import * as AWS from "@/AWS";
import { Certificate, CertificateProvider } from "@/AWS/ACM/Certificate.ts";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/aws/acm";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as route53 from "@distilled.cloud/aws/route-53";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers() });

// Anchor the fixture to the repo root regardless of the runner's cwd.
const fixtureDir = fileURLToPath(
  new URL("../../../../../examples/aws-static-site/site", import.meta.url),
);

interface BindingRow {
  sid: string;
  data: any;
}

/**
 * Compile a composition (registration only — no plan, no apply, no cloud
 * calls) and return the binding rows the engine collected, keyed by target
 * FQN. Mirrors the compile harness in test/binding-stability.test.ts.
 */
const compileStack = (
  build: Effect.Effect<any, any, any>,
): Effect.Effect<
  { bindings: Record<string, BindingRow[]>; resourceFqns: string[] },
  never,
  never
> =>
  Effect.scoped(
    (build as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "wave3-hostname-binding",
        providers: Layer.empty,
        state: inMemoryState(),
      } as any),
      Effect.map((compiled: any) => ({
        bindings: compiled.bindings as Record<string, BindingRow[]>,
        resourceFqns: Object.keys(compiled.resources) as string[],
      })),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<
    { bindings: Record<string, BindingRow[]>; resourceFqns: string[] },
    never,
    never
  >;

const siteRowsOf = (bindings: Record<string, BindingRow[]>) =>
  Object.entries(bindings).flatMap(([fqn, rows]) =>
    rows
      .filter((row) => row.sid.startsWith("AWS.Website.Site"))
      .map((row) => ({ fqn, ...row })),
  );

describe("AWS.Website Router hostname binding (composition)", () => {
  test(
    "attached site's domain declaration binds concrete hostnames onto the Router's distribution, certificate, and record set",
    Effect.gen(function* () {
      const compiled = yield* compileStack(
        Effect.gen(function* () {
          const router = yield* AWS.Website.Router("Router", {
            domain: {
              name: "router.example.com",
              hostedZoneId: "Z1234567890ABC",
            },
          });
          yield* AWS.Website.StaticSite("DocsSite", {
            path: fixtureDir,
            domain: {
              name: "docs.example.com",
              // The wildcard alias is a host pattern — nothing concrete to
              // register, so it must NOT appear in the bound hostnames.
              aliases: ["*.preview.example.com", "assets.example.com"],
              redirects: ["old.example.com"],
              router,
              path: "/docs",
            },
          });
          return {};
        }),
      );

      const expected = [
        "docs.example.com",
        "assets.example.com",
        "old.example.com",
      ];

      const distributionRow = (
        compiled.bindings["Router/Distribution"] ?? []
      ).find((row) => row.sid === "AWS.Website.Site(DocsSite)");
      expect(distributionRow?.data.aliases).toEqual(expected);

      const certificateRow = (
        compiled.bindings["Router/Certificate"] ?? []
      ).find((row) => row.sid === "AWS.Website.Site(DocsSite)");
      expect(certificateRow?.data.subjectAlternativeNames).toEqual(expected);

      const recordsRow = (
        compiled.bindings["Router/SiteAliasRecords"] ?? []
      ).find((row) => row.sid === "AWS.Website.Site(DocsSite)");
      expect(recordsRow?.data.names).toEqual(expected);

      // The Router creates the record-set bind target alongside its own
      // per-hostname alias records.
      expect(compiled.resourceFqns).toContain("Router/SiteAliasRecords");
    }),
  );

  test(
    "removing the attached site removes its binding rows",
    Effect.gen(function* () {
      const compiled = yield* compileStack(
        Effect.gen(function* () {
          yield* AWS.Website.Router("Router", {
            domain: {
              name: "router.example.com",
              hostedZoneId: "Z1234567890ABC",
            },
          });
          return {};
        }),
      );
      expect(siteRowsOf(compiled.bindings)).toEqual([]);
    }),
  );

  test(
    "path-only and wildcard-only attachments bind nothing",
    Effect.gen(function* () {
      const compiled = yield* compileStack(
        Effect.gen(function* () {
          const router = yield* AWS.Website.Router("Router", {
            domain: {
              name: "router.example.com",
              hostedZoneId: "Z1234567890ABC",
            },
          });
          yield* AWS.Website.StaticSite("PathOnlySite", {
            path: fixtureDir,
            domain: { router, path: "/path-only" },
          });
          yield* AWS.Website.StaticSite("WildcardSite", {
            path: fixtureDir,
            domain: { name: "*.example.com", router, path: "/wild" },
          });
          return {};
        }),
      );
      expect(siteRowsOf(compiled.bindings)).toEqual([]);
    }),
  );

  test(
    "a Router without a domain exposes no bind targets (no certificate to cover aliases)",
    Effect.gen(function* () {
      const compiled = yield* compileStack(
        Effect.gen(function* () {
          const router = yield* AWS.Website.Router("Router", {});
          yield* AWS.Website.StaticSite("DocsSite", {
            path: fixtureDir,
            domain: { name: "docs.example.com", router },
          });
          return { router };
        }),
      );
      expect(siteRowsOf(compiled.bindings)).toEqual([]);
    }),
  );

  test(
    "a user-provided cert Router binds aliases and records but not the certificate",
    Effect.gen(function* () {
      const compiled = yield* compileStack(
        Effect.gen(function* () {
          const router = yield* AWS.Website.Router("Router", {
            domain: {
              name: "router.example.com",
              hostedZoneId: "Z1234567890ABC",
              cert: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
            },
          });
          yield* AWS.Website.StaticSite("DocsSite", {
            path: fixtureDir,
            domain: { name: "docs.example.com", router },
          });
          return {};
        }),
      );
      const rows = siteRowsOf(compiled.bindings);
      expect(rows.map((row) => row.fqn).sort()).toEqual([
        "Router/Distribution",
        "Router/SiteAliasRecords",
      ]);
    }),
  );

  test(
    "cross-stack router refs fall back to KV host-matching only (no bindings, no error)",
    Effect.gen(function* () {
      const compiled = yield* compileStack(
        Effect.gen(function* () {
          // A hand-built structural slice, as a cross-stack consumer would
          // assemble from another stack's outputs — carries no bindTargets.
          const routerRef = {
            kvStoreArn: "arn:aws:cloudfront::123456789012:key-value-store/9f6a",
            kvNamespace: "9f6a",
            distributionId: "E1234567890ABC",
            distributionArn:
              "arn:aws:cloudfront::123456789012:distribution/E1234567890ABC",
            url: "https://d111111abcdef8.cloudfront.net",
          };
          yield* AWS.Website.StaticSite("DocsSite", {
            path: fixtureDir,
            domain: { name: "docs.example.com", router: routerRef },
          });
          return {};
        }),
      );
      expect(siteRowsOf(compiled.bindings)).toEqual([]);
      // The KV route registration (host-matching) still happens.
      expect(compiled.resourceFqns).toContain("DocsSite/RoutesUpdate");
    }),
  );

  test(
    // Plan-safety: ACM SANs are immutable, so a change in the BOUND SAN set
    // must plan a certificate REPLACEMENT (create-first swap), not an
    // in-place update. Prop/alias deltas on the Distribution ride the
    // engine's default binding diff (any changed row plans an update).
    "a bound SAN delta plans a certificate replacement",
    Effect.gen(function* () {
      const provider = yield* Certificate.Provider;
      const olds = {
        domainName: "router.example.com",
        subjectAlternativeNames: [] as string[],
        hostedZoneId: "Z1234567890ABC",
      };
      const base = {
        id: "Certificate",
        fqn: "Router/Certificate",
        instanceId: "wave3instance",
        olds,
        news: olds,
        output: undefined,
      };

      // Adding a bound hostname → replace.
      const added = yield* provider.diff!({
        ...base,
        oldBindings: [],
        newBindings: [
          {
            sid: "AWS.Website.Site(DocsSite)",
            data: { subjectAlternativeNames: ["docs.example.com"] },
          },
        ],
      });
      expect(added?.action).toBe("replace");

      // Removing it → replace.
      const removed = yield* provider.diff!({
        ...base,
        oldBindings: [
          {
            sid: "AWS.Website.Site(DocsSite)",
            data: { subjectAlternativeNames: ["docs.example.com"] },
          },
        ],
        newBindings: [],
      });
      expect(removed?.action).toBe("replace");

      // Identical bound SANs → no provider-forced action (engine noops).
      const unchanged = yield* provider.diff!({
        ...base,
        oldBindings: [
          {
            sid: "AWS.Website.Site(DocsSite)",
            data: { subjectAlternativeNames: ["docs.example.com"] },
          },
        ],
        newBindings: [
          {
            sid: "AWS.Website.Site(DocsSite)",
            data: { subjectAlternativeNames: ["docs.example.com"] },
          },
        ],
      });
      expect(unchanged).toBeUndefined();
    }).pipe(Effect.provide(certificateProviderForDiff())),
  );
});

/**
 * The Certificate provider with dummy ambient services: `diff` is a pure
 * SAN comparison (no network), but the provider layer and its lifecycle
 * effects are typed against the AWS environment, so satisfy it with inert
 * stand-ins. Composed as ONE layer so the test provides exactly once.
 */
function certificateProviderForDiff() {
  const ambient = Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(Stack.Stack, {
      name: "wave3-hostname-binding",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, "test"),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make("test"),
        secretAccessKey: Redacted.make("test"),
        sessionToken: undefined,
        region: "us-east-1" as RegionName,
      }),
    ),
  );
  return Layer.mergeAll(
    CertificateProvider().pipe(Layer.provide(ambient)),
    ambient,
  );
}

// ---------------------------------------------------------------------------
// Live verification — gated on AWS_TEST_HOSTED_ZONE=<zone-name> (e.g.
// "alchemy-test.example.com"). The shared testing account currently has NO
// hosted zone, so this cannot run there; it is implemented for an account
// that has one. The suite also folds in wave-2's deferred gated checks
// (cloudfrontUrl:false 301 and redirect 301), which need the same zone.
// ---------------------------------------------------------------------------

const testZone = process.env.AWS_TEST_HOSTED_ZONE;

describe.skipIf(!testZone)("AWS.Website Router hostname binding (live)", () => {
  test.provider(
    "attached site's declaration alone provisions alias + SAN + DNS and serves over HTTPS",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const zoneName = testZone!.replace(/\.$/, "");
        const zone = yield* route53
          .listHostedZonesByName({ DNSName: `${zoneName}.` })
          .pipe(
            Effect.map((response) =>
              (response.HostedZones ?? []).find(
                (candidate) => candidate.Name === `${zoneName}.`,
              ),
            ),
          );
        if (!zone?.Id) {
          return yield* Effect.die(
            `AWS_TEST_HOSTED_ZONE=${zoneName} does not resolve to a hosted zone in this account`,
          );
        }
        const hostedZoneId = zone.Id.replace(/^\/hostedzone\//, "");
        const routerHost = `wave3-router.${zoneName}`;
        const siteHost = `wave3-docs.${zoneName}`;
        const redirectHost = `wave3-old.${zoneName}`;

        const routerOnly = Effect.gen(function* () {
          const router = yield* AWS.Website.Router("Router", {
            domain: { name: routerHost, hostedZoneId },
            // Wave-2 deferred gated check: default-domain requests 301 to
            // the canonical domain.
            cloudfrontUrl: false,
            invalidation: { paths: "all", wait: true },
          });
          return { router };
        });

        const withSite = Effect.gen(function* () {
          const { router } = yield* routerOnly;
          const site = yield* AWS.Website.StaticSite("DocsSite", {
            path: fixtureDir,
            forceDestroy: true,
            domain: {
              name: siteHost,
              // Wave-2 deferred gated check: redirect hostnames 301 with
              // path + query preserved.
              redirects: [redirectHost],
              router,
            },
          });
          return { router, site };
        });

        const deployed = yield* stack.deploy(withSite);
        const distributionId = deployed.router.distribution
          .distributionId as string;

        // Distribution aliases: the router's own hostname plus the site's
        // bound hostnames (canonical + redirect).
        const config = yield* cloudfront.getDistributionConfig({
          Id: distributionId,
        });
        const aliases = config.DistributionConfig?.Aliases?.Items ?? [];
        expect(aliases).toContain(routerHost);
        expect(aliases).toContain(siteHost);
        expect(aliases).toContain(redirectHost);

        // Certificate: issued, SANs cover the bound hostnames.
        const certificateArn = (deployed.router.certificate as any)
          .certificateArn as string;
        const certificate = yield* acm.describeCertificate({
          CertificateArn: certificateArn,
        });
        expect(certificate.Certificate?.Status).toBe("ISSUED");
        const sans = certificate.Certificate?.SubjectAlternativeNames ?? [];
        expect(sans).toContain(siteHost);
        expect(sans).toContain(redirectHost);

        // Route 53: A-alias records exist for the bound hostnames.
        const recordFor = (name: string) =>
          route53
            .listResourceRecordSets({
              HostedZoneId: hostedZoneId,
              StartRecordName: `${name}.`,
              StartRecordType: "A",
              MaxItems: 5,
            })
            .pipe(
              Effect.map((response) =>
                (response.ResourceRecordSets ?? []).find(
                  (recordSet) =>
                    recordSet.Name === `${name}.` && recordSet.Type === "A",
                ),
              ),
            );
        expect(yield* recordFor(siteHost)).toBeDefined();
        expect(yield* recordFor(redirectHost)).toBeDefined();

        // Manual-redirect fetch (the platform HttpClient follows redirects,
        // which would hide the 301s under test). Retries ride out DNS/cert/
        // edge propagation on freshly-created hostnames.
        const fetchManual = (url: string) =>
          Effect.tryPromise(async (signal) => {
            const response = await fetch(url, {
              signal,
              redirect: "manual",
              cache: "no-store",
              headers: { "cache-control": "no-cache" },
            });
            return {
              status: response.status,
              location: response.headers.get("location"),
            };
          });
        const expectResponse = (
          url: string,
          check: (response: {
            status: number;
            location: string | null;
          }) => boolean,
        ) =>
          fetchManual(url).pipe(
            Effect.flatMap((response) =>
              check(response)
                ? Effect.succeed(response)
                : Effect.fail(
                    new Error(
                      `unexpected response from ${url}: ${response.status} -> ${response.location}`,
                    ),
                  ),
            ),
            Effect.retry({
              schedule: Schedule.exponential("2 seconds"),
              times: 12,
            }),
          );

        // HTTPS: the site serves on its own hostname (edge + DNS + TLS).
        yield* expectResponse(
          `https://${siteHost}/`,
          (response) => response.status === 200,
        );

        // Redirect hostname 301s to the canonical site hostname, path and
        // query preserved.
        yield* expectResponse(
          `https://${redirectHost}/some/path?q=1`,
          (response) =>
            response.status === 301 &&
            response.location === `https://${siteHost}/some/path?q=1`,
        );

        // cloudfrontUrl:false — default-domain requests 301 to the
        // canonical router domain.
        const defaultDomain = deployed.router.distribution.domainName as string;
        yield* expectResponse(
          `https://${defaultDomain}/x?y=2`,
          (response) =>
            response.status === 301 &&
            response.location === `https://${routerHost}/x?y=2`,
        );

        // Removal path: redeploy without the site — the bound hostnames must
        // leave the distribution aliases, the certificate is replaced
        // (create-first) with the shrunk SAN set, and the DNS records are
        // garbage-collected from the record set.
        const shrunk = yield* stack.deploy(routerOnly);
        const shrunkConfig = yield* cloudfront.getDistributionConfig({
          Id: shrunk.router.distribution.distributionId as string,
        });
        const shrunkAliases =
          shrunkConfig.DistributionConfig?.Aliases?.Items ?? [];
        expect(shrunkAliases).toContain(routerHost);
        expect(shrunkAliases).not.toContain(siteHost);
        expect(shrunkAliases).not.toContain(redirectHost);
        const shrunkCertificateArn = (shrunk.router.certificate as any)
          .certificateArn as string;
        expect(shrunkCertificateArn).not.toBe(certificateArn);
        expect(yield* recordFor(siteHost)).toBeUndefined();
        expect(yield* recordFor(redirectHost)).toBeUndefined();

        yield* stack.destroy();
      }),
    // Two full CloudFront distribution deployments + two ACM issuances +
    // disable→wait→delete on destroy. Same order of budget as the Router
    // live lifecycle test (which needed 2400s), plus the cert swap.
    { timeout: 3_000_000 },
  );
});

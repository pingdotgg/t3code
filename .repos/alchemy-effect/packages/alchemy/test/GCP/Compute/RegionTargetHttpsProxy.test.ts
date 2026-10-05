import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  CERT_A_PEM,
  CERT_B_PEM,
  KEY_A_PEM,
  KEY_B_PEM,
} from "./fixtures/https-proxy-cert.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const region = "us-central1";

const waitUntilGone = (project: string, targetHttpsProxyName: string) =>
  compute
    .getRegionTargetHttpsProxies({
      project,
      region,
      targetHttpsProxy: targetHttpsProxyName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

test.provider(
  "create, update, and delete a regional target https proxy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Compute.RegionUrlMap("Web", {
            region,
            description: "https redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const cert = yield* GCP.Compute.RegionSslCertificate("TlsA", {
            region,
            description: "frontend tls a",
            certificate: CERT_A_PEM,
            privateKey: KEY_A_PEM,
          });
          const proxy = yield* GCP.Compute.RegionTargetHttpsProxy("Proxy", {
            region,
            description: "https frontend",
            urlMap: map.urlMapName,
            sslCertificates: [cert.sslCertificateName],
          });
          return { map, cert, proxy };
        }),
      );

      expect(created.proxy.targetHttpsProxyName).toEqual(expect.any(String));
      expect(created.proxy.region).toEqual(region);
      expect(created.proxy.description).toEqual("https frontend");
      expect(resourceTail(created.proxy.urlMap)).toEqual(
        created.map.urlMapName,
      );
      expect(created.proxy.sslCertificates.map(resourceTail)).toContain(
        created.cert.sslCertificateName,
      );

      const fetched = yield* compute.getRegionTargetHttpsProxies({
        project: created.proxy.project,
        region,
        targetHttpsProxy: created.proxy.targetHttpsProxyName,
      });
      expect(fetched.name).toEqual(created.proxy.targetHttpsProxyName);
      expect(resourceTail(fetched.urlMap)).toEqual(
        resourceTail(created.proxy.urlMap),
      );
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("https frontend");
      expect((fetched.sslCertificates ?? []).map(resourceTail)).toContain(
        created.cert.sslCertificateName,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GCP.Compute.RegionUrlMap("Web", {
            urlMapName: created.map.urlMapName,
            region,
            description: "https redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const other = yield* GCP.Compute.RegionUrlMap("Other", {
            region,
            description: "alt redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.org",
              stripQuery: true,
            },
          });
          yield* GCP.Compute.RegionSslCertificate("TlsA", {
            sslCertificateName: created.cert.sslCertificateName,
            region,
            description: "frontend tls a",
            certificate: CERT_A_PEM,
            privateKey: KEY_A_PEM,
          });
          const certB = yield* GCP.Compute.RegionSslCertificate("TlsB", {
            region,
            description: "frontend tls b",
            certificate: CERT_B_PEM,
            privateKey: KEY_B_PEM,
          });
          const proxy = yield* GCP.Compute.RegionTargetHttpsProxy("Proxy", {
            targetHttpsProxyName: created.proxy.targetHttpsProxyName,
            region,
            description: "updated https",
            urlMap: other.urlMapName,
            sslCertificates: [certB.sslCertificateName],
          });
          return { other, certB, proxy };
        }),
      );

      expect(updated.proxy.targetHttpsProxyName).toEqual(
        created.proxy.targetHttpsProxyName,
      );
      expect(updated.proxy.description).toEqual("updated https");
      expect(resourceTail(updated.proxy.urlMap)).toEqual(
        updated.other.urlMapName,
      );
      expect(updated.proxy.sslCertificates.map(resourceTail)).toContain(
        updated.certB.sslCertificateName,
      );
      expect(updated.proxy.sslCertificates.map(resourceTail)).not.toContain(
        created.cert.sslCertificateName,
      );

      const refetched = yield* compute.getRegionTargetHttpsProxies({
        project: updated.proxy.project,
        region,
        targetHttpsProxy: updated.proxy.targetHttpsProxyName,
      });
      expect(refetched.description).toContain("updated https");
      expect(resourceTail(refetched.urlMap)).toEqual(
        resourceTail(updated.proxy.urlMap),
      );
      expect(resourceTail(refetched.urlMap)).not.toEqual(
        resourceTail(created.proxy.urlMap),
      );
      expect((refetched.sslCertificates ?? []).map(resourceTail)).toContain(
        updated.certB.sslCertificateName,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.proxy.project,
        created.proxy.targetHttpsProxyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

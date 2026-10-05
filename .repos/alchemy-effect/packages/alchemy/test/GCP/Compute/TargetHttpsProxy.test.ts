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
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (targetHttpsProxyName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getTargetHttpsProxies({
          project,
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
        ),
    ),
  );

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

test.provider(
  "create, update, and delete a target https proxy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Compute.UrlMap("Web", {
            description: "https redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const cert = yield* GCP.Compute.SslCertificate("TlsA", {
            description: "frontend tls a",
            certificate: CERT_A_PEM,
            privateKey: KEY_A_PEM,
          });
          const proxy = yield* GCP.Compute.TargetHttpsProxy("Proxy", {
            description: "https frontend",
            urlMap: map.urlMapName,
            sslCertificates: [cert.sslCertificateName],
          });
          return { map, cert, proxy };
        }),
      );

      expect(created.proxy.targetHttpsProxyName).toEqual(expect.any(String));
      expect(created.proxy.description).toEqual("https frontend");
      expect(
        created.proxy.quicOverride === "NONE" ||
          created.proxy.quicOverride === undefined,
      ).toEqual(true);
      expect(resourceTail(created.proxy.urlMap)).toEqual(
        created.map.urlMapName,
      );
      expect(created.proxy.sslCertificates.map(resourceTail)).toContain(
        created.cert.sslCertificateName,
      );

      const fetched = yield* compute.getTargetHttpsProxies({
        project,
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
          yield* GCP.Compute.UrlMap("Web", {
            urlMapName: created.map.urlMapName,
            description: "https redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const other = yield* GCP.Compute.UrlMap("Other", {
            description: "alt redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.org",
              stripQuery: true,
            },
          });
          yield* GCP.Compute.SslCertificate("TlsA", {
            sslCertificateName: created.cert.sslCertificateName,
            description: "frontend tls a",
            certificate: CERT_A_PEM,
            privateKey: KEY_A_PEM,
          });
          const certB = yield* GCP.Compute.SslCertificate("TlsB", {
            description: "frontend tls b",
            certificate: CERT_B_PEM,
            privateKey: KEY_B_PEM,
          });
          const proxy = yield* GCP.Compute.TargetHttpsProxy("Proxy", {
            targetHttpsProxyName: created.proxy.targetHttpsProxyName,
            description: "updated https",
            urlMap: other.urlMapName,
            sslCertificates: [certB.sslCertificateName],
            quicOverride: "ENABLE",
          });
          return { other, certB, proxy };
        }),
      );

      expect(updated.proxy.targetHttpsProxyName).toEqual(
        created.proxy.targetHttpsProxyName,
      );
      expect(updated.proxy.description).toEqual("updated https");
      expect(updated.proxy.quicOverride).toEqual("ENABLE");
      expect(resourceTail(updated.proxy.urlMap)).toEqual(
        updated.other.urlMapName,
      );
      expect(updated.proxy.sslCertificates.map(resourceTail)).toContain(
        updated.certB.sslCertificateName,
      );
      expect(updated.proxy.sslCertificates.map(resourceTail)).not.toContain(
        created.cert.sslCertificateName,
      );

      const refetched = yield* compute.getTargetHttpsProxies({
        project,
        targetHttpsProxy: updated.proxy.targetHttpsProxyName,
      });
      expect(refetched.description).toContain("updated https");
      expect(refetched.quicOverride).toEqual("ENABLE");
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

      const gone = yield* waitUntilGone(created.proxy.targetHttpsProxyName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

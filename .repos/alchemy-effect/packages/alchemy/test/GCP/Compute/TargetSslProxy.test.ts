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

const waitUntilGone = (targetSslProxyName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getTargetSslProxies({ project, targetSslProxy: targetSslProxyName })
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
  "create, update, and delete a target ssl proxy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* GCP.Compute.HealthCheck("Probe", {
            description: "ssl probe",
            type: "TCP",
            tcpHealthCheck: { port: 443 },
          });
          const backend = yield* GCP.Compute.BackendService("SslA", {
            protocol: "SSL",
            loadBalancingScheme: "EXTERNAL",
            description: "ssl backend a",
            healthChecks: [check.selfLink.as<string>()],
          });
          const cert = yield* GCP.Compute.SslCertificate("TlsA", {
            description: "frontend tls a",
            certificate: CERT_A_PEM,
            privateKey: KEY_A_PEM,
          });
          const proxy = yield* GCP.Compute.TargetSslProxy("Proxy", {
            description: "ssl frontend",
            service: backend.name,
            sslCertificates: [cert.sslCertificateName],
          });
          return { check, backend, cert, proxy };
        }),
      );

      expect(created.proxy.targetSslProxyName).toEqual(expect.any(String));
      expect(created.proxy.description).toEqual("ssl frontend");
      expect(
        created.proxy.proxyHeader === "NONE" ||
          created.proxy.proxyHeader === undefined,
      ).toEqual(true);
      expect(resourceTail(created.proxy.service)).toEqual(created.backend.name);
      expect(created.proxy.sslCertificates.map(resourceTail)).toContain(
        created.cert.sslCertificateName,
      );

      const fetched = yield* compute.getTargetSslProxies({
        project,
        targetSslProxy: created.proxy.targetSslProxyName,
      });
      expect(fetched.name).toEqual(created.proxy.targetSslProxyName);
      expect(resourceTail(fetched.service)).toEqual(
        resourceTail(created.proxy.service),
      );
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("ssl frontend");
      expect((fetched.sslCertificates ?? []).map(resourceTail)).toContain(
        created.cert.sslCertificateName,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* GCP.Compute.HealthCheck("Probe", {
            healthCheckName: created.check.healthCheckName,
            description: "ssl probe",
            type: "TCP",
            tcpHealthCheck: { port: 443 },
          });
          yield* GCP.Compute.BackendService("SslA", {
            name: created.backend.name,
            protocol: "SSL",
            loadBalancingScheme: "EXTERNAL",
            description: "ssl backend a",
            healthChecks: [check.selfLink.as<string>()],
          });
          const other = yield* GCP.Compute.BackendService("SslB", {
            protocol: "SSL",
            loadBalancingScheme: "EXTERNAL",
            description: "ssl backend b",
            healthChecks: [check.selfLink.as<string>()],
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
          const proxy = yield* GCP.Compute.TargetSslProxy("Proxy", {
            targetSslProxyName: created.proxy.targetSslProxyName,
            description: "ssl frontend",
            service: other.name,
            sslCertificates: [certB.sslCertificateName],
            proxyHeader: "PROXY_V1",
          });
          return { other, certB, proxy };
        }),
      );

      expect(updated.proxy.targetSslProxyName).toEqual(
        created.proxy.targetSslProxyName,
      );
      expect(updated.proxy.description).toEqual("ssl frontend");
      expect(updated.proxy.proxyHeader).toEqual("PROXY_V1");
      expect(resourceTail(updated.proxy.service)).toEqual(updated.other.name);
      expect(updated.proxy.sslCertificates.map(resourceTail)).toContain(
        updated.certB.sslCertificateName,
      );
      expect(updated.proxy.sslCertificates.map(resourceTail)).not.toContain(
        created.cert.sslCertificateName,
      );

      const refetched = yield* compute.getTargetSslProxies({
        project,
        targetSslProxy: updated.proxy.targetSslProxyName,
      });
      expect(refetched.description).toContain("ssl frontend");
      expect(refetched.proxyHeader).toEqual("PROXY_V1");
      expect(resourceTail(refetched.service)).toEqual(
        resourceTail(updated.proxy.service),
      );
      expect(resourceTail(refetched.service)).not.toEqual(
        resourceTail(created.proxy.service),
      );
      expect((refetched.sslCertificates ?? []).map(resourceTail)).toContain(
        updated.certB.sslCertificateName,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.proxy.targetSslProxyName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);

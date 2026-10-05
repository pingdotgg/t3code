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

const region = "us-central1";

const waitUntilGone = (sslCertificateName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getRegionSslCertificates({
          project,
          region,
          sslCertificate: sslCertificateName,
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

test.provider(
  "create, replace, and delete a regional ssl certificate",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionSslCertificate("FrontendTls", {
            region,
            description: "frontend tls a",
            certificate: CERT_A_PEM,
            privateKey: KEY_A_PEM,
          });
        }),
      );

      expect(created.sslCertificateName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.type).toEqual("SELF_MANAGED");
      expect(created.description).toEqual("frontend tls a");
      expect(created.certificate).toContain(
        "MIIDIDCCAgigAwIBAgIUD2oKsfjRQWSWaAiVXJCmak8GeWMw",
      );
      expect(created.expireTime).toEqual(expect.any(String));
      expect(created.selfLink).toEqual(expect.any(String));

      const fetched = yield* compute.getRegionSslCertificates({
        project,
        region,
        sslCertificate: created.sslCertificateName,
      });
      expect(fetched.name).toEqual(created.sslCertificateName);
      expect(fetched.type).toEqual("SELF_MANAGED");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("frontend tls a");
      expect(fetched.certificate).toContain("BEGIN CERTIFICATE");
      expect(fetched.certificate).toContain(
        "MIIDIDCCAgigAwIBAgIUD2oKsfjRQWSWaAiVXJCmak8GeWMw",
      );

      const listed = yield* compute.listRegionSslCertificates({
        project,
        region,
        maxResults: 500,
      });
      expect(
        (listed.items ?? []).some(
          (cert) => cert.name === created.sslCertificateName,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionSslCertificate("FrontendTls", {
            sslCertificateName: created.sslCertificateName,
            region,
            description: "frontend tls b",
            certificate: CERT_B_PEM,
            privateKey: KEY_B_PEM,
          });
        }),
      );

      expect(updated.sslCertificateName).toEqual(created.sslCertificateName);
      expect(updated.description).toEqual("frontend tls b");
      expect(updated.certificate).toContain(
        "MIIDITCCAgmgAwIBAgIUD2oKsfjRQWSWaAiVXJCmak8GeWQw",
      );
      expect(updated.certificate).not.toContain(
        "MIIDIDCCAgigAwIBAgIUD2oKsfjRQWSWaAiVXJCmak8GeWMw",
      );

      const refetched = yield* compute.getRegionSslCertificates({
        project,
        region,
        sslCertificate: updated.sslCertificateName,
      });
      expect(refetched.description).toContain("frontend tls b");
      expect(refetched.certificate).toContain(
        "MIIDITCCAgmgAwIBAgIUD2oKsfjRQWSWaAiVXJCmak8GeWQw",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.sslCertificateName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const location = "us-central1";

const waitUntilGone = (name: string) =>
  certificatemanager
    .getProjectsLocationsCertificateIssuanceConfigs({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsCertificateIssuanceConfigs on a missing config fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        certificatemanager.getProjectsLocationsCertificateIssuanceConfigs({
          name: `projects/${project}/locations/${location}/certificateIssuanceConfigs/alchemy-issuance-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:certificatemanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a certificate issuance config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.PrivateCA.CaPool("IssuancePool", {
            location,
            tier: "DEVOPS",
            labels: { env: "test" },
          });
          const ca = yield* GCP.PrivateCA.CertificateAuthority("IssuanceCa", {
            caPool: pool.name,
            location,
            type: "SELF_SIGNED",
            desiredState: "ENABLED",
            lifetime: "315360000s",
            keySpec: { algorithm: "EC_P256_SHA256" },
            config: {
              subjectConfig: {
                subject: {
                  organization: "Alchemy",
                  commonName: "Alchemy Issuance Test Root",
                },
              },
              x509Config: {
                caOptions: { isCa: true },
                keyUsage: {
                  baseKeyUsage: {
                    certSign: true,
                    crlSign: true,
                  },
                },
              },
            },
          });
          return yield* GCP.CertificateManager.CertificateIssuanceConfig(
            "WorkloadTls",
            {
              location,
              description: "issuance a",
              labels: { env: "test", ca: ca.certificateAuthorityId },
              lifetime: "2592000s",
              rotationWindowPercentage: 66,
              keyAlgorithm: "ECDSA_P256",
              certificateAuthorityConfig: {
                certificateAuthorityServiceConfig: {
                  caPool: pool.name,
                },
              },
            },
          );
        }),
      );

      expect(created.name).toContain("/certificateIssuanceConfigs/");
      expect(created.certificateIssuanceConfigId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.description).toEqual("issuance a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.lifetime).toEqual("2592000s");
      expect(created.rotationWindowPercentage).toEqual(66);
      expect(created.keyAlgorithm).toEqual("ECDSA_P256");
      expect(created.caPool).toContain("/caPools/");

      const fetched =
        yield* certificatemanager.getProjectsLocationsCertificateIssuanceConfigs(
          {
            name: created.name,
          },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("issuance a");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.lifetime).toEqual("2592000s");
      expect(fetched.rotationWindowPercentage).toEqual(66);
      expect(fetched.keyAlgorithm).toEqual("ECDSA_P256");
      expect(
        fetched.certificateAuthorityConfig?.certificateAuthorityServiceConfig
          ?.caPool,
      ).toEqual(created.caPool);
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.PrivateCA.CaPool("IssuancePool", {
            location,
            caPoolId: created.caPool.split("/").pop(),
            tier: "DEVOPS",
            labels: { env: "test" },
          });
          const ca = yield* GCP.PrivateCA.CertificateAuthority("IssuanceCa", {
            caPool: pool.name,
            location,
            type: "SELF_SIGNED",
            desiredState: "ENABLED",
            lifetime: "315360000s",
            keySpec: { algorithm: "EC_P256_SHA256" },
            config: {
              subjectConfig: {
                subject: {
                  organization: "Alchemy",
                  commonName: "Alchemy Issuance Test Root",
                },
              },
              x509Config: {
                caOptions: { isCa: true },
                keyUsage: {
                  baseKeyUsage: {
                    certSign: true,
                    crlSign: true,
                  },
                },
              },
            },
          });
          return yield* GCP.CertificateManager.CertificateIssuanceConfig(
            "WorkloadTls",
            {
              certificateIssuanceConfigId: created.certificateIssuanceConfigId,
              location,
              description: "issuance b",
              labels: {
                env: "prod",
                role: "tls",
                ca: ca.certificateAuthorityId,
              },
              lifetime: "2592000s",
              rotationWindowPercentage: 66,
              keyAlgorithm: "ECDSA_P256",
              certificateAuthorityConfig: {
                certificateAuthorityServiceConfig: {
                  caPool: pool.name,
                },
              },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("issuance b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "tls" });
      expect(updated.lifetime).toEqual("2592000s");
      expect(updated.keyAlgorithm).toEqual("ECDSA_P256");
      expect(updated.caPool).toEqual(created.caPool);

      const refetched =
        yield* certificatemanager.getProjectsLocationsCertificateIssuanceConfigs(
          {
            name: created.name,
          },
        );
      expect(refetched.description).toEqual("issuance b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tls");
      expect(refetched.lifetime).toEqual("2592000s");
      expect(refetched.keyAlgorithm).toEqual("ECDSA_P256");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:certificatemanager", "live"],
    timeout: 120_000,
  },
);

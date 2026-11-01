import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as privateca from "@distilled.cloud/gcp/privateca_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "us-central1";

const waitUntilGone = (name: string) =>
  privateca.getProjectsLocationsCaPoolsCertificateAuthorities({ name }).pipe(
    Effect.map((ca) =>
      (ca.state ?? "").toUpperCase() === "DELETED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCaPoolsCertificateAuthorities on a missing CA fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        privateca.getProjectsLocationsCaPoolsCertificateAuthorities({
          name: `projects/${project}/locations/${location}/caPools/alchemy-capool-missing/certificateAuthorities/alchemy-ca-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page =
        yield* privateca.listProjectsLocationsCaPoolsCertificateAuthorities({
          parent: `projects/${project}/locations/${location}/caPools/-`,
          pageSize: 10,
        });
      expect(
        (page.certificateAuthorities ?? []).map((authority) => authority.name),
      ).not.toContain(
        `projects/${project}/locations/${location}/caPools/alchemy-capool-missing/certificateAuthorities/alchemy-ca-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:privateca", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a certificate authority",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.PrivateCA.CaPool("Pool", {
            location,
            tier: "DEVOPS",
            labels: { env: "test" },
          });
          return yield* GCP.PrivateCA.CertificateAuthority("Root", {
            caPool: pool.name,
            location,
            type: "SELF_SIGNED",
            desiredState: "STAGED",
            lifetime: "315360000s",
            keySpec: { algorithm: "EC_P256_SHA256" },
            labels: { env: "test" },
            config: {
              subjectConfig: {
                subject: {
                  organization: "Alchemy",
                  commonName: "Alchemy Test Root",
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
        }),
      );

      expect(created.name).toContain("/certificateAuthorities/");
      expect(created.certificateAuthorityId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.type).toEqual("SELF_SIGNED");
      expect(created.caPool).toContain("/caPools/");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("STAGED");

      const fetched =
        yield* privateca.getProjectsLocationsCaPoolsCertificateAuthorities({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.type).toEqual("SELF_SIGNED");
      expect(fetched.state).toEqual("STAGED");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.PrivateCA.CaPool("Pool", {
            location,
            caPoolId: created.caPool.split("/").pop(),
            tier: "DEVOPS",
            labels: { env: "test" },
          });
          return yield* GCP.PrivateCA.CertificateAuthority("Root", {
            caPool: pool.name,
            location,
            certificateAuthorityId: created.certificateAuthorityId,
            type: "SELF_SIGNED",
            desiredState: "STAGED",
            lifetime: "315360000s",
            keySpec: { algorithm: "EC_P256_SHA256" },
            labels: { env: "prod", role: "ca" },
            config: {
              subjectConfig: {
                subject: {
                  organization: "Alchemy",
                  commonName: "Alchemy Test Root",
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
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "ca" });
      expect(updated.state).toEqual("STAGED");

      const refetched =
        yield* privateca.getProjectsLocationsCaPoolsCertificateAuthorities({
          name: created.name,
        });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ca");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:privateca", "live"],
    timeout: 120_000,
  },
);

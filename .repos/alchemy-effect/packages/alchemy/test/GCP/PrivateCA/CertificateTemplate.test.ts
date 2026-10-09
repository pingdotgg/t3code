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

const waitUntilGone = (name: string) =>
  privateca.getProjectsLocationsCertificateTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCertificateTemplates on a missing template fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        privateca.getProjectsLocationsCertificateTemplates({
          name: `projects/${project}/locations/us-central1/certificateTemplates/alchemy-template-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* privateca.listProjectsLocationsCertificateTemplates({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(
        (page.certificateTemplates ?? []).map((template) => template.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/certificateTemplates/alchemy-template-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:privateca", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, replace, and delete a certificate template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PrivateCA.CertificateTemplate("LeafTls", {
            location: "us-central1",
            description: "leaf tls a",
            maximumLifetime: "86400s",
            labels: { env: "test" },
            identityConstraints: {
              allowSubjectPassthrough: true,
              allowSubjectAltNamesPassthrough: true,
            },
            passthroughExtensions: {
              knownExtensions: ["EXTENDED_KEY_USAGE"],
            },
            predefinedValues: {
              caOptions: { isCa: false },
              keyUsage: {
                baseKeyUsage: {
                  digitalSignature: true,
                  keyEncipherment: true,
                },
                extendedKeyUsage: { serverAuth: true },
              },
            },
          });
        }),
      );

      expect(created.name).toContain("/certificateTemplates/");
      expect(created.certificateTemplateId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("leaf tls a");
      expect(created.maximumLifetime).toEqual("86400s");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.identityConstraints?.allowSubjectPassthrough).toEqual(
        true,
      );
      expect(
        created.identityConstraints?.allowSubjectAltNamesPassthrough,
      ).toEqual(true);
      expect(created.passthroughExtensions?.knownExtensions).toContain(
        "EXTENDED_KEY_USAGE",
      );
      expect(created.predefinedValues?.caOptions?.isCa).toEqual(false);
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* privateca.getProjectsLocationsCertificateTemplates(
        {
          name: created.name,
        },
      );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("leaf tls a");
      expect(fetched.maximumLifetime).toEqual("86400s");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PrivateCA.CertificateTemplate("LeafTls", {
            certificateTemplateId: created.certificateTemplateId,
            location: "us-central1",
            description: "leaf tls b",
            maximumLifetime: "172800s",
            labels: { env: "prod", role: "tls" },
            identityConstraints: {
              allowSubjectPassthrough: true,
              allowSubjectAltNamesPassthrough: false,
            },
            passthroughExtensions: {
              knownExtensions: ["BASE_KEY_USAGE", "EXTENDED_KEY_USAGE"],
            },
            predefinedValues: {
              caOptions: { isCa: false },
              keyUsage: {
                baseKeyUsage: {
                  digitalSignature: true,
                  keyEncipherment: true,
                },
                extendedKeyUsage: { serverAuth: true, clientAuth: true },
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("leaf tls b");
      expect(updated.maximumLifetime).toEqual("172800s");
      expect(updated.labels).toMatchObject({ env: "prod", role: "tls" });
      expect(
        updated.identityConstraints?.allowSubjectAltNamesPassthrough,
      ).toEqual(false);
      expect(updated.passthroughExtensions?.knownExtensions).toEqual(
        expect.arrayContaining(["BASE_KEY_USAGE", "EXTENDED_KEY_USAGE"]),
      );
      expect(
        updated.predefinedValues?.keyUsage?.extendedKeyUsage?.clientAuth,
      ).toEqual(true);

      const refetched =
        yield* privateca.getProjectsLocationsCertificateTemplates({
          name: created.name,
        });
      expect(refetched.description).toEqual("leaf tls b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tls");
      expect(refetched.maximumLifetime).toEqual("172800s");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PrivateCA.CertificateTemplate("LeafTls", {
            certificateTemplateId: created.certificateTemplateId,
            location: "us-east1",
            description: "leaf tls east",
            maximumLifetime: "86400s",
            labels: { env: "prod" },
            identityConstraints: {
              allowSubjectPassthrough: true,
              allowSubjectAltNamesPassthrough: true,
            },
          });
        }),
      );

      expect(replaced.location).toEqual("us-east1");
      expect(replaced.certificateTemplateId).toEqual(
        created.certificateTemplateId,
      );
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.name).toContain("/locations/us-east1/");

      const fetchedReplacement =
        yield* privateca.getProjectsLocationsCertificateTemplates({
          name: replaced.name,
        });
      expect(fetchedReplacement.name).toEqual(replaced.name);
      expect(fetchedReplacement.labels?.env).toEqual("prod");

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:privateca", "live"],
    timeout: 120_000,
  },
);

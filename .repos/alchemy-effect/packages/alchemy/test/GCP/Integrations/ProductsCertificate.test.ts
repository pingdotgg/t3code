import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CERT_A_PEM, KEY_A_PEM } from "../Compute/fixtures/https-proxy-cert.ts";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsProductsCertificates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsProductsCertificates on a missing cert fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsProductsCertificates({
          name: `projects/${project}/locations/us-central1/products/IP/certificates/alchemy-missing-cert`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a product certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsCertificate("ClientTls", {
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-client-tls",
            description: "client tls",
            rawCertificate: {
              sslCertificate: CERT_A_PEM,
              encryptedPrivateKey: KEY_A_PEM,
            },
          });
        }),
      );

      expect(created.name).toContain("/certificates/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("alchemy-client-tls");
      expect(created.description).toEqual("client tls");

      const fetched =
        yield* integrations.getProjectsLocationsProductsCertificates({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsCertificate("ClientTls", {
            certificateId: created.certificateId,
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-client-tls",
            description: "updated cert",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated cert");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

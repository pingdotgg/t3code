import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
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
  certificatemanager.getProjectsLocationsCertificateMaps({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a certificate map",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.CertificateMap("FrontendMap", {
            location: "global",
            description: "frontend map a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/certificateMaps/");
      expect(created.certificateMapId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("frontend map a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.gclbTargets).toEqual([]);
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* certificatemanager.getProjectsLocationsCertificateMaps({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("frontend map a");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CertificateManager.CertificateMap("FrontendMap", {
            certificateMapId: created.certificateMapId,
            location: "global",
            description: "frontend map b",
            labels: { env: "prod", role: "tls" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("frontend map b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "tls" });

      const refetched =
        yield* certificatemanager.getProjectsLocationsCertificateMaps({
          name: created.name,
        });
      expect(refetched.description).toEqual("frontend map b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tls");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:certificatemanager", "live"],
    timeout: 90_000,
  },
);

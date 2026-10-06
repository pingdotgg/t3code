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
  privateca.getProjectsLocationsCaPools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCaPools on a missing pool fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        privateca.getProjectsLocationsCaPools({
          name: `projects/${project}/locations/us-central1/caPools/alchemy-capool-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* privateca.listProjectsLocationsCaPools({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.caPools ?? []).map((pool) => pool.name)).not.toContain(
        `projects/${project}/locations/us-central1/caPools/alchemy-capool-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:privateca", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a ca pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PrivateCA.CaPool("AppCa", {
            location: "us-central1",
            tier: "DEVOPS",
            labels: { env: "test" },
            publishingOptions: {
              publishCaCert: false,
              publishCrl: false,
            },
          });
        }),
      );

      expect(created.name).toContain("/caPools/");
      expect(created.caPoolId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.tier).toEqual("DEVOPS");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.publishingOptions?.publishCaCert ?? false).toEqual(false);
      expect(created.publishingOptions?.publishCrl ?? false).toEqual(false);

      const fetched = yield* privateca.getProjectsLocationsCaPools({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.tier).toEqual("DEVOPS");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const trust = yield* privateca.fetchCaCertsProjectsLocationsCaPools({
        caPool: created.name,
        body: {},
      });
      // A pool without certificate authorities has no trust anchors.
      expect(trust.caCerts ?? []).toEqual([]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PrivateCA.CaPool("AppCa", {
            caPoolId: created.caPoolId,
            location: "us-central1",
            tier: "DEVOPS",
            labels: { env: "prod", role: "ca" },
            publishingOptions: {
              publishCaCert: false,
              publishCrl: false,
              encodingFormat: "PEM",
            },
            issuancePolicy: {
              maximumLifetime: "2592000s",
              allowedIssuanceModes: {
                allowConfigBasedIssuance: true,
                allowCsrBasedIssuance: true,
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "ca" });
      expect(updated.publishingOptions?.publishCaCert ?? false).toEqual(false);
      expect(updated.issuancePolicy?.maximumLifetime).toEqual("2592000s");

      const refetched = yield* privateca.getProjectsLocationsCaPools({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ca");
      expect(refetched.issuancePolicy?.maximumLifetime).toEqual("2592000s");
      expect(
        refetched.issuancePolicy?.allowedIssuanceModes
          ?.allowConfigBasedIssuance,
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:privateca", "live"],
    timeout: 120_000,
  },
);

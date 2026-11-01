import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsTlsInspectionPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTlsInspectionPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsTlsInspectionPolicies({
          name: `projects/${project}/locations/us-central1/tlsInspectionPolicies/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a tls inspection policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.PrivateCA.CaPool("InspectPool", {
            location: "us-central1",
            tier: "DEVOPS",
            labels: { env: "test" },
          });
          const ca = yield* GCP.PrivateCA.CertificateAuthority("InspectRoot", {
            caPool: pool.name,
            location: "us-central1",
            type: "SELF_SIGNED",
            desiredState: "ENABLED",
            labels: { env: "test" },
          });
          return yield* GCP.NetworkSecurity.TlsInspectionPolicy("Inspect", {
            location: "us-central1",
            caPool: pool.name,
            description: Output.interpolate`inspect a ${ca.certificateAuthorityId}`,
            excludePublicCaSet: true,
          });
        }),
      );

      expect(created.name).toContain("/tlsInspectionPolicies/");
      expect(created.name).toContain("/locations/us-central1/");
      expect(created.tlsInspectionPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toContain("inspect a");
      expect(created.caPool).toContain("/caPools/");
      expect(created.excludePublicCaSet).toEqual(true);
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsTlsInspectionPolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.caPool).toEqual(created.caPool);
      expect(fetched.excludePublicCaSet).toEqual(true);
      expect(fetched.description ?? "").toContain("[alchemy ");
      expect(fetched.description ?? "").toContain("inspect a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.PrivateCA.CaPool("InspectPool", {
            location: "us-central1",
            caPoolId: created.caPool?.split("/").pop(),
            tier: "DEVOPS",
            labels: { env: "test" },
          });
          const ca = yield* GCP.PrivateCA.CertificateAuthority("InspectRoot", {
            caPool: pool.name,
            location: "us-central1",
            type: "SELF_SIGNED",
            desiredState: "ENABLED",
            labels: { env: "test" },
          });
          return yield* GCP.NetworkSecurity.TlsInspectionPolicy("Inspect", {
            tlsInspectionPolicyId: created.tlsInspectionPolicyId,
            location: "us-central1",
            caPool: pool.name,
            description: Output.interpolate`inspect b ${ca.certificateAuthorityId}`,
            excludePublicCaSet: true,
            minTlsVersion: "TLS_1_2",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toContain("inspect b");
      expect(updated.minTlsVersion).toEqual("TLS_1_2");

      const refetched =
        yield* networksecurity.getProjectsLocationsTlsInspectionPolicies({
          name: created.name,
        });
      expect(refetched.description ?? "").toContain("inspect b");
      expect(refetched.minTlsVersion).toEqual("TLS_1_2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 180_000,
  },
);

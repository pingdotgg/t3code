import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const region = "us-central1";

const waitUntilGone = (project: string, sslPolicyName: string) =>
  compute
    .getRegionSslPolicies({ project, region, sslPolicy: sslPolicyName })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const CUSTOM_FEATURES = [
  "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
];

test.provider(
  "create, update, and delete a regional ssl policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionSslPolicy("FrontendTls", {
            region,
            description: "frontend tls",
            profile: "MODERN",
            minTlsVersion: "TLS_1_2",
          });
        }),
      );

      expect(created.sslPolicyName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.profile).toEqual("MODERN");
      expect(created.minTlsVersion).toEqual("TLS_1_2");
      expect(created.description).toEqual("frontend tls");
      expect(created.enabledFeatures.length).toBeGreaterThan(0);
      expect(created.selfLink).toEqual(expect.any(String));

      const fetched = yield* compute.getRegionSslPolicies({
        project: created.project,
        region,
        sslPolicy: created.sslPolicyName,
      });
      expect(fetched.name).toEqual(created.sslPolicyName);
      expect(fetched.profile).toEqual("MODERN");
      expect(fetched.minTlsVersion).toEqual("TLS_1_2");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("frontend tls");

      const listed = yield* compute.listRegionSslPolicies({
        project: created.project,
        region,
        maxResults: 500,
      });
      expect(
        (listed.items ?? []).some(
          (policy) => policy.name === created.sslPolicyName,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionSslPolicy("FrontendTls", {
            sslPolicyName: created.sslPolicyName,
            region,
            description: "strict tls",
            profile: "RESTRICTED",
            minTlsVersion: "TLS_1_2",
          });
        }),
      );

      expect(updated.sslPolicyName).toEqual(created.sslPolicyName);
      expect(updated.profile).toEqual("RESTRICTED");
      expect(updated.minTlsVersion).toEqual("TLS_1_2");
      expect(updated.description).toEqual("strict tls");

      const refetched = yield* compute.getRegionSslPolicies({
        project: updated.project,
        region,
        sslPolicy: updated.sslPolicyName,
      });
      expect(refetched.profile).toEqual("RESTRICTED");
      expect(refetched.minTlsVersion).toEqual("TLS_1_2");
      expect(refetched.description).toContain("strict tls");

      const customized = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionSslPolicy("FrontendTls", {
            sslPolicyName: created.sslPolicyName,
            region,
            description: "custom ciphers",
            profile: "CUSTOM",
            minTlsVersion: "TLS_1_2",
            customFeatures: CUSTOM_FEATURES,
          });
        }),
      );

      expect(customized.sslPolicyName).toEqual(created.sslPolicyName);
      expect(customized.profile).toEqual("CUSTOM");
      expect(customized.customFeatures.sort()).toEqual(
        [...CUSTOM_FEATURES].sort(),
      );
      expect(customized.description).toEqual("custom ciphers");

      const afterCustom = yield* compute.getRegionSslPolicies({
        project: customized.project,
        region,
        sslPolicy: customized.sslPolicyName,
      });
      expect(afterCustom.profile).toEqual("CUSTOM");
      expect([...(afterCustom.customFeatures ?? [])].sort()).toEqual(
        [...CUSTOM_FEATURES].sort(),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.sslPolicyName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

import * as GCP from "@/GCP";
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

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsSecurityProfileGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSecurityProfileGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsSecurityProfileGroups({
          name: `projects/${project}/locations/global/securityProfileGroups/alchemy-missing`,
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

test.provider(
  "create, update, and delete a security profile group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
            location: "global",
            type: "THREAT_PREVENTION",
            labels: { env: "test" },
            threatPreventionProfile: {
              severityOverrides: [{ severity: "HIGH", action: "ALERT" }],
            },
          });
          return yield* GCP.NetworkSecurity.SecurityProfileGroup("Ngfw", {
            location: "global",
            description: "profile group a",
            labels: { env: "test" },
            threatPreventionProfile: profile.name,
          });
        }),
      );

      expect(created.name).toContain("/securityProfileGroups/");
      expect(created.name).toContain("/locations/global/");
      expect(created.securityProfileGroupId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("profile group a");
      expect(created.threatPreventionProfile).toContain("/securityProfiles/");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsSecurityProfileGroups({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("profile group a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
            location: "global",
            securityProfileId: created.threatPreventionProfile
              ?.split("/")
              .pop(),
            type: "THREAT_PREVENTION",
            labels: { env: "test" },
            threatPreventionProfile: {
              severityOverrides: [{ severity: "HIGH", action: "ALERT" }],
            },
          });
          return yield* GCP.NetworkSecurity.SecurityProfileGroup("Ngfw", {
            securityProfileGroupId: created.securityProfileGroupId,
            location: "global",
            description: "profile group b",
            labels: { env: "prod", role: "ngfw" },
            threatPreventionProfile: profile.name,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("profile group b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ngfw" });

      const refetched =
        yield* networksecurity.getProjectsLocationsSecurityProfileGroups({
          name: created.name,
        });
      expect(refetched.description).toEqual("profile group b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ngfw");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

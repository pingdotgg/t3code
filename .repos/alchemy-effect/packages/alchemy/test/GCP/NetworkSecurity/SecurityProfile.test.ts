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
  networksecurity.getProjectsLocationsSecurityProfiles({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSecurityProfiles on a missing profile fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsSecurityProfiles({
          name: `projects/${project}/locations/global/securityProfiles/alchemy-missing`,
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
  "create, update, and delete a security profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
            location: "global",
            description: "threat profile a",
            labels: { env: "test" },
            type: "THREAT_PREVENTION",
            threatPreventionProfile: {
              severityOverrides: [{ severity: "HIGH", action: "ALERT" }],
            },
          });
        }),
      );

      expect(created.name).toContain("/securityProfiles/");
      expect(created.name).toContain("/locations/global/");
      expect(created.securityProfileId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.type).toEqual("THREAT_PREVENTION");
      expect(created.description).toEqual("threat profile a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.threatPreventionProfile?.severityOverrides).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "HIGH", action: "ALERT" }),
        ]),
      );
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsSecurityProfiles({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("threat profile a");
      expect(fetched.type).toEqual("THREAT_PREVENTION");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
            securityProfileId: created.securityProfileId,
            location: "global",
            description: "threat profile b",
            labels: { env: "prod", role: "ngfw" },
            type: "THREAT_PREVENTION",
            threatPreventionProfile: {
              severityOverrides: [{ severity: "CRITICAL", action: "DENY" }],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("threat profile b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ngfw" });
      expect(updated.threatPreventionProfile?.severityOverrides).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "CRITICAL", action: "DENY" }),
        ]),
      );

      const refetched =
        yield* networksecurity.getProjectsLocationsSecurityProfiles({
          name: created.name,
        });
      expect(refetched.description).toEqual("threat profile b");
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

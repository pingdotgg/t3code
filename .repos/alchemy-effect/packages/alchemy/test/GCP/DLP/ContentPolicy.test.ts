import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
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
  dlp.getProjectsLocationsContentPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsContentPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsContentPolicies({
          name: `projects/${project}/locations/us/contentPolicies/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a content policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.ContentPolicy("BlockEmail", {
            location: "us",
            displayName: "email",
            inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            rules: [
              {
                conditions: [
                  {
                    infoTypeCondition: {
                      infoTypes: { infoTypeNames: ["EMAIL_ADDRESS"] },
                    },
                  },
                ],
                action: { returnVerdict: "BLOCK" },
              },
            ],
            defaultAction: { returnVerdict: "ALLOW" },
          });
        }),
      );

      expect(created.contentPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us");
      expect(created.name).toContain("/contentPolicies/");
      expect(created.displayName).toEqual("email");
      expect(created.rules.length).toBeGreaterThan(0);

      const fetched = yield* dlp.getProjectsLocationsContentPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.ContentPolicy("BlockEmail", {
            contentPolicyId: created.contentPolicyId,
            location: "us",
            displayName: "email2",
            inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            rules: [
              {
                conditions: [
                  {
                    infoTypeCondition: {
                      infoTypes: { infoTypeNames: ["EMAIL_ADDRESS"] },
                    },
                  },
                ],
                action: { returnVerdict: "BLOCK" },
              },
            ],
            defaultAction: { returnVerdict: "ALLOW" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("email2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

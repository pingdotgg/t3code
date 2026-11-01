import * as GCP from "@/GCP";
import { quotaTolerant } from "./parent.ts";
import * as Test from "@/Test/Alchemy";
import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
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
// Non-global Dialogflow CX locations need the {region}-dialogflow host, which
// distilled does not route to yet; the global location works everywhere.
const location = "global";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsSecuritySettings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSecuritySettings on a missing setting fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsSecuritySettings({
          name: `projects/${project}/locations/${location}/securitySettings/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete security settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.SecuritySetting("Retention", {
            location,
            displayName: "session-only",
            retentionStrategy: "REMOVE_AFTER_CONVERSATION",
          });
        }),
      );

      expect(created.name).toContain("/securitySettings/");
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("session-only");
      expect(created.retentionStrategy).toEqual("REMOVE_AFTER_CONVERSATION");

      const fetched = yield* dialogflow.getProjectsLocationsSecuritySettings({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toMatch(/^\[(alchemy|alc) /);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.SecuritySetting("Retention", {
            location,
            securitySettingsId: created.securitySettingsId,
            displayName: "thirty-days",
            retentionWindowDays: 30,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("thirty-days");
      expect(updated.retentionWindowDays).toEqual(30);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);

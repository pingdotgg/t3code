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
  dlp.getProjectsStoredInfoTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsStoredInfoTypes on a missing stored info type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsStoredInfoTypes({
          name: `projects/${project}/storedInfoTypes/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a project stored info type",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.StoredInfoType("Account", {
            displayName: "account ids",
            description: "internal account numbers",
            regex: { pattern: "ACCT[0-9]{8}" },
          });
        }),
      );

      expect(created.storedInfoTypeId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/storedInfoTypes/${created.storedInfoTypeId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.displayName).toEqual("account ids");
      expect(created.description).toEqual("internal account numbers");
      expect(created.regex?.pattern).toEqual("ACCT[0-9]{8}");

      const fetched = yield* dlp.getProjectsStoredInfoTypes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.currentVersion?.config?.description).toContain(
        "alchemy-id=",
      );
      expect(fetched.currentVersion?.config?.regex?.pattern).toEqual(
        "ACCT[0-9]{8}",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.StoredInfoType("Account", {
            storedInfoTypeId: created.storedInfoTypeId,
            displayName: "account ids",
            description: "internal account numbers v2",
            regex: { pattern: "ACCT[0-9]{10}" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("internal account numbers v2");
      expect(updated.regex?.pattern).toEqual("ACCT[0-9]{10}");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

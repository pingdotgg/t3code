import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
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
  logging.getProjectsExclusions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a logging exclusion",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.Exclusion("DropDebug", {
            filter: "severity=DEBUG",
            description: "drop debug entries",
          });
        }),
      );

      expect(created.exclusionId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/exclusions/${created.exclusionId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.filter).toEqual("severity=DEBUG");
      expect(created.description).toEqual("drop debug entries");
      expect(created.disabled).toEqual(false);

      const fetched = yield* logging.getProjectsExclusions({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.exclusionId);
      expect(fetched.filter).toEqual("severity=DEBUG");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("drop debug entries");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.Exclusion("DropDebug", {
            exclusionId: created.exclusionId,
            filter: "severity<ERROR",
            description: "drop non-errors",
            disabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.exclusionId).toEqual(created.exclusionId);
      expect(updated.filter).toEqual("severity<ERROR");
      expect(updated.description).toEqual("drop non-errors");
      expect(updated.disabled).toEqual(true);
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate = yield* logging.getProjectsExclusions({
        name: created.name,
      });
      expect(fetchedUpdate.filter).toEqual("severity<ERROR");
      expect(fetchedUpdate.disabled).toEqual(true);
      expect(fetchedUpdate.description).toContain("drop non-errors");

      const last = created.exclusionId.at(-1) ?? "a";
      const nextExclusionId = `${created.exclusionId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.Exclusion("DropDebug", {
            exclusionId: nextExclusionId,
            filter: "severity=DEBUG",
            description: "replaced exclusion",
          });
        }),
      );

      expect(replaced.exclusionId).not.toEqual(created.exclusionId);
      expect(replaced.name).toEqual(
        `projects/${project}/exclusions/${replaced.exclusionId}`,
      );
      expect(replaced.description).toEqual("replaced exclusion");

      const fetchedReplacement = yield* logging.getProjectsExclusions({
        name: replaced.name,
      });
      expect(fetchedReplacement.name).toEqual(replaced.exclusionId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

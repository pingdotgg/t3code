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
  logging.getFoldersLocationsSavedQueries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a folder logging saved query",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.FolderSavedQuery("Errors", {
            displayName: "application errors",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "error query",
          });
        }),
      );

      expect(created.savedQueryId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.parent).toEqual(`projects/${project}`);
      expect(created.name).toEqual(
        `projects/${project}/locations/global/savedQueries/${created.savedQueryId}`,
      );
      expect(created.displayName).toEqual("application errors");
      expect(created.visibility).toEqual("PRIVATE");
      expect(created.loggingQuery?.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("error query");

      const fetched = yield* logging.getFoldersLocationsSavedQueries({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("application errors");
      expect(fetched.loggingQuery?.filter).toEqual("severity>=ERROR");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("error query");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.FolderSavedQuery("Errors", {
            savedQueryId: created.savedQueryId,
            displayName: "warnings and errors",
            loggingQuery: { filter: "severity>=WARNING" },
            description: "warning query",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("warnings and errors");
      expect(updated.loggingQuery?.filter).toEqual("severity>=WARNING");
      expect(updated.description).toEqual("warning query");

      const last = created.savedQueryId.at(-1) ?? "a";
      const nextId = `${created.savedQueryId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.FolderSavedQuery("Errors", {
            savedQueryId: nextId,
            displayName: "replaced query",
            loggingQuery: { filter: "severity>=WARNING" },
            description: "replaced query",
          });
        }),
      );

      expect(replaced.savedQueryId).not.toEqual(created.savedQueryId);
      expect(replaced.displayName).toEqual("replaced query");

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

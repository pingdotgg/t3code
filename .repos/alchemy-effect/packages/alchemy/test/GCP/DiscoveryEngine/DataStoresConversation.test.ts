import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { ensureDataStore, quotaTolerant } from "./parent.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Conversations need the Large Language Model add-on (BadRequest "This
// feature is only available when Large Language Model add-on is enabled.").
// Set GCP_TEST_DISCOVERYENGINE_LLM=1 on a project with the add-on.
const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_DISCOVERYENGINE_LLM;
const parentId = "alchds3conv";

const waitUntilGone = (name: string) =>
  discoveryengine.getProjectsLocationsDataStoresConversations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataStoresConversations on a missing conversation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsDataStoresConversations({
          name: `projects/${project}/locations/global/dataStores/alchemy-missing/conversations/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST || runLifecycle)(
  "createProjectsLocationsDataStoresConversations without the LLM add-on is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const parent = yield* ensureDataStore(project, parentId, {
        contentConfig: "NO_CONTENT",
      });
      const error = yield* Effect.flip(
        discoveryengine.createProjectsLocationsDataStoresConversations({
          parent: parent.name ?? "",
          body: { userPseudoId: "alchemy-probe" },
        }),
      );
      expect(error._tag).toEqual("LlmAddOnRequired");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data store conversation",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const parent = yield* ensureDataStore(project, parentId, {
        contentConfig: "NO_CONTENT",
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStoresConversation("Support", {
            dataStore: parent.name ?? "",
          });
        }),
      );

      expect(created.name).toContain("/conversations/");
      expect(created.dataStore).toEqual(parent.name);

      const fetched =
        yield* discoveryengine.getProjectsLocationsDataStoresConversations({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStoresConversation("Support", {
            dataStore: parent.name ?? "",
            state: "COMPLETED",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.state).toEqual("COMPLETED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);

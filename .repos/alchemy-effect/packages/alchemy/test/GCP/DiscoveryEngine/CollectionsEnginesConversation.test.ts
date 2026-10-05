import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import { quotaTolerant } from "./parent.ts";
import * as Test from "@/Test/Alchemy";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const waitUntilGone = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesConversations({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsCollectionsEnginesConversations on a missing conversation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsEnginesConversations({
          name: `projects/${project}/locations/global/collections/default_collection/engines/alchemy-missing/conversations/alchemy-missing`,
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

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an engine conversation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "conversation-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "conversation engine",
            },
          );
          const conversation =
            yield* GCP.DiscoveryEngine.CollectionsEnginesConversation("Chat", {
              engine: engine.name,
              state: "IN_PROGRESS",
            });
          return { store, engine, conversation };
        }),
      );

      expect(created.conversation.name).toContain("/conversations/");
      expect(created.conversation.engine).toEqual(created.engine.name);
      expect(created.conversation.state).toEqual("IN_PROGRESS");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsEnginesConversations(
          { name: created.conversation.name },
        );
      expect(fetched.name).toEqual(created.conversation.name);
      expect(fetched.state).toEqual("IN_PROGRESS");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              displayName: "conversation-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "conversation engine",
            },
          );
          const conversation =
            yield* GCP.DiscoveryEngine.CollectionsEnginesConversation("Chat", {
              engine: engine.name,
              state: "COMPLETED",
            });
          return { store, engine, conversation };
        }),
      );

      expect(updated.conversation.name).toEqual(created.conversation.name);
      expect(updated.conversation.state).toEqual("COMPLETED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.conversation.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);

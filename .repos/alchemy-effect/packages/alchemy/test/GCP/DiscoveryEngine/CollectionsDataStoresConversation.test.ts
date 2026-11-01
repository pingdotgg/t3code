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

const runLifecycle = !process.env.FAST;
// Conversations need the Large Language Model add-on (BadRequest "This
// feature is only available when Large Language Model add-on is enabled.").
// Set GCP_TEST_DISCOVERYENGINE_LLM=1 on a project with the add-on.
const runLlmLifecycle =
  runLifecycle && !!process.env.GCP_TEST_DISCOVERYENGINE_LLM;

const waitUntilGone = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsDataStoresConversations({ name })
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
  "getProjectsLocationsCollectionsDataStoresConversations on a missing conversation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsDataStoresConversations({
          name: `projects/${project}/locations/global/collections/default_collection/dataStores/alchemy-missing/conversations/alchemy-missing`,
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

test.provider.skipIf(!runLifecycle || runLlmLifecycle)(
  "create conversation without LLM add-on fails with LlmAddOnRequired",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const store = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {
            location: "global",
            displayName: "docs",
            disableCmek: true,
          });
        }),
      );

      const error = yield* Effect.flip(
        discoveryengine.createProjectsLocationsCollectionsDataStoresConversations(
          {
            parent: store.name,
            body: { userPseudoId: "probe", state: "IN_PROGRESS" },
          },
        ),
      );
      expect(error._tag).toEqual("LlmAddOnRequired");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);

test.provider.skipIf(!runLlmLifecycle)(
  "create, update, and delete a collection data store conversation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "docs",
              disableCmek: true,
            },
          );
          const conversation =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresConversation(
              "Visitor",
              {
                dataStore: store.name,
                userPseudoId: "user-1",
                state: "IN_PROGRESS",
              },
            );
          return { store, conversation };
        }),
      );

      expect(created.conversation.name).toContain("/conversations/");
      expect(created.conversation.userPseudoId).toEqual("user-1");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsDataStoresConversations(
          { name: created.conversation.name },
        );
      expect(fetched.name).toEqual(created.conversation.name);
      expect(fetched.userPseudoId).toContain("alc-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              collection: created.store.collection,
              displayName: "docs",
              disableCmek: true,
            },
          );
          const conversation =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresConversation(
              "Visitor",
              {
                dataStore: store.name,
                userPseudoId: "user-2",
                state: "COMPLETED",
              },
            );
          return { store, conversation };
        }),
      );

      expect(updated.conversation.name).toEqual(created.conversation.name);
      expect(updated.conversation.userPseudoId).toEqual("user-2");
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

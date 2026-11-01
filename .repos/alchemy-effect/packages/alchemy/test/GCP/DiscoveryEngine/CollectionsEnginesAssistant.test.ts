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

// createAssistants is rejected on a plain search engine with BadRequest "Only
// default_assistant is allowed." even for assistantId default_assistant; it
// needs a Gemini Enterprise (Agentspace) engine. Set
// GCP_TEST_DISCOVERYENGINE_ASSISTANT=1 on a project with one.
const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_DISCOVERYENGINE_ASSISTANT;

const waitUntilGone = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesAssistants({ name })
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
  "getProjectsLocationsCollectionsEnginesAssistants on a missing assistant fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsEnginesAssistants({
          name: `projects/${project}/locations/global/collections/default_collection/engines/alchemy-missing/assistants/alchemy-missing`,
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
  "create, update, and delete an engine assistant",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "assistant-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "assistant engine",
            },
          );
          const assistant =
            yield* GCP.DiscoveryEngine.CollectionsEnginesAssistant("Help", {
              engine: engine.name,
              // Engines accept only their default assistant.
              assistantId: "default_assistant",
              displayName: "docs helper",
              description: "answers",
            });
          return { store, engine, assistant };
        }),
      );

      expect(created.assistant.name).toContain("/assistants/");
      expect(created.assistant.engine).toEqual(created.engine.name);
      expect(created.assistant.displayName).toEqual("docs helper");
      expect(created.assistant.description).toEqual("answers");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsEnginesAssistants(
          { name: created.assistant.name },
        );
      expect(fetched.name).toEqual(created.assistant.name);
      expect(fetched.description).toEqual("answers");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              displayName: "assistant-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "assistant engine",
            },
          );
          const assistant =
            yield* GCP.DiscoveryEngine.CollectionsEnginesAssistant("Help", {
              engine: engine.name,
              assistantId: created.assistant.assistantId,
              displayName: "docs helper prod",
              description: "answers prod",
            });
          return { store, engine, assistant };
        }),
      );

      expect(updated.assistant.name).toEqual(created.assistant.name);
      expect(updated.assistant.displayName).toEqual("docs helper prod");
      expect(updated.assistant.description).toEqual("answers prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.assistant.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);

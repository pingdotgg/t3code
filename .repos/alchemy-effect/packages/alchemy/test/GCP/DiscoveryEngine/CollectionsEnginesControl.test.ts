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

const waitUntilGone = (name: string) =>
  discoveryengine.getProjectsLocationsCollectionsEnginesControls({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCollectionsEnginesControls on a missing control fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsEnginesControls({
          name: `projects/${project}/locations/global/collections/default_collection/engines/alchemy-missing/controls/alchemy-missing`,
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
  "create, update, and delete an engine control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "control-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "control engine",
            },
          );
          const control = yield* GCP.DiscoveryEngine.CollectionsEnginesControl(
            "Synonyms",
            {
              engine: engine.name,
              displayName: "hello-hi",
              synonymsAction: { synonyms: ["hello", "hi"] },
            },
          );
          return { store, engine, control };
        }),
      );

      expect(created.control.name).toContain("/controls/");
      expect(created.control.engine).toEqual(created.engine.name);
      expect(created.control.displayName).toEqual("hello-hi");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsEnginesControls({
          name: created.control.name,
        });
      expect(fetched.name).toEqual(created.control.name);
      expect(fetched.synonymsAction?.synonyms).toEqual(
        expect.arrayContaining(["hello", "hi"]),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              displayName: "control-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "control engine",
            },
          );
          const control = yield* GCP.DiscoveryEngine.CollectionsEnginesControl(
            "Synonyms",
            {
              engine: engine.name,
              controlId: created.control.controlId,
              displayName: "greetings",
              synonymsAction: { synonyms: ["hello", "hi", "hey"] },
            },
          );
          return { store, engine, control };
        }),
      );

      expect(updated.control.name).toEqual(created.control.name);
      expect(updated.control.displayName).toEqual("greetings");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.control.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);

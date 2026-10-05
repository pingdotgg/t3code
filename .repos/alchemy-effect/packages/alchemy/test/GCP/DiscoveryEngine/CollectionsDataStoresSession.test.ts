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
  discoveryengine
    .getProjectsLocationsCollectionsDataStoresSessions({ name })
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
  "getProjectsLocationsCollectionsDataStoresSessions on a missing session fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsDataStoresSessions({
          name: `projects/${project}/locations/global/collections/default_collection/dataStores/alchemy-missing/sessions/alchemy-missing`,
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
  "create, update, and delete a collection data store session",
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
          const session =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresSession("Chat", {
              dataStore: store.name,
              displayName: "chat",
              isPinned: true,
            });
          return { store, session };
        }),
      );

      expect(created.session.name).toContain("/sessions/");
      expect(created.session.displayName).toEqual("chat");
      expect(created.session.isPinned).toEqual(true);

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsDataStoresSessions(
          { name: created.session.name },
        );
      expect(fetched.name).toEqual(created.session.name);
      expect(fetched.displayName).toEqual("chat");

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
          const session =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresSession("Chat", {
              dataStore: store.name,
              sessionId: created.session.sessionId,
              displayName: "prod",
              isPinned: false,
            });
          return { store, session };
        }),
      );

      expect(updated.session.name).toEqual(created.session.name);
      expect(updated.session.displayName).toEqual("prod");
      expect(updated.session.isPinned).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.session.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);

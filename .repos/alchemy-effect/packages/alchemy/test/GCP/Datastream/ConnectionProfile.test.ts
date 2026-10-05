import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datastream from "@distilled.cloud/gcp/datastream_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  LOCATION,
  logLevel,
  currentProject,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsConnectionProfiles on a missing profile fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datastream.getProjectsLocationsConnectionProfiles({
          name: `projects/${project}/locations/${LOCATION}/connectionProfiles/alchemy-missing-profile`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datastream", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigquery connection profile",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datastream.ConnectionProfile("BqDest", {
            location: LOCATION,
            displayName: "bq-dest",
            labels: { env: "test" },
            bigqueryProfile: {},
          });
        }),
      );

      expect(created.connectionProfileId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/${LOCATION}/connectionProfiles/${created.connectionProfileId}`,
      );
      expect(created.location).toEqual(LOCATION);
      expect(created.displayName).toEqual("bq-dest");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.bigqueryProfile).toEqual({});

      const fetched = yield* datastream.getProjectsLocationsConnectionProfiles({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("bq-dest");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datastream.ConnectionProfile("BqDest", {
            connectionProfileId: created.connectionProfileId,
            location: LOCATION,
            displayName: "bq-dest-v2",
            labels: { env: "prod", team: "datastream" },
            bigqueryProfile: {},
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("bq-dest-v2");
      expect(updated.labels).toMatchObject({ env: "prod", team: "datastream" });

      const fetchedUpdate =
        yield* datastream.getProjectsLocationsConnectionProfiles({
          name: updated.name,
        });
      expect(fetchedUpdate.displayName).toEqual("bq-dest-v2");
      expect(fetchedUpdate.labels?.team).toEqual("datastream");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datastream.getProjectsLocationsConnectionProfiles({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datastream", "live"],
    timeout: 300_000,
  },
);

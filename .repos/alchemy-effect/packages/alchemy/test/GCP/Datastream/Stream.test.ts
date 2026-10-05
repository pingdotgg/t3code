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
  "getProjectsLocationsStreams on a missing stream fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datastream.getProjectsLocationsStreams({
          name: `projects/${project}/locations/${LOCATION}/streams/alchemy-missing-stream`,
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
  "create and delete a mysql-to-bigquery stream",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Datastream.ConnectionProfile("MysqlSrc", {
            location: LOCATION,
            displayName: "mysql-src",
            mysqlProfile: {
              hostname: "10.0.0.8",
              port: 3306,
              username: "alchemy",
              password: "AlchemyTestPass1",
            },
            staticServiceIpConnectivity: {},
            force: true,
          });
          const dest = yield* GCP.Datastream.ConnectionProfile("BqDest", {
            location: LOCATION,
            displayName: "bq-dest",
            bigqueryProfile: {},
          });
          const stream = yield* GCP.Datastream.Stream("MysqlToBq", {
            location: LOCATION,
            displayName: "mysql-to-bq",
            labels: { env: "test" },
            sourceConfig: {
              sourceConnectionProfile: source.name,
              mysqlSourceConfig: {
                includeObjects: {
                  mysqlDatabases: [{ database: "alchemy" }],
                },
              },
            },
            destinationConfig: {
              destinationConnectionProfile: dest.name,
              bigqueryDestinationConfig: {
                singleTargetDataset: {
                  datasetId: `${project}:alchemy_ds`,
                },
                dataFreshness: "900s",
              },
            },
            backfillNone: {},
            force: true,
          });
          return { source, dest, stream };
        }),
      );

      expect(created.stream.streamId).toEqual(expect.any(String));
      expect(created.stream.name).toEqual(
        `projects/${project}/locations/${LOCATION}/streams/${created.stream.streamId}`,
      );
      expect(created.stream.location).toEqual(LOCATION);
      expect(created.stream.displayName).toEqual("mysql-to-bq");
      expect(created.stream.labels).toMatchObject({ env: "test" });
      expect(created.stream.sourceConfig?.sourceConnectionProfile).toContain(
        created.source.connectionProfileId,
      );
      expect(
        created.stream.destinationConfig?.destinationConnectionProfile,
      ).toContain(created.dest.connectionProfileId);

      const fetched = yield* datastream.getProjectsLocationsStreams({
        name: created.stream.name,
      });
      expect(fetched.name).toEqual(created.stream.name);
      expect(fetched.displayName).toEqual("mysql-to-bq");
      expect(fetched.labels?.env).toEqual("test");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datastream.getProjectsLocationsStreams({
          name: created.stream.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datastream", "live"],
    timeout: 600_000,
  },
);

import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigqueryconnection from "@distilled.cloud/gcp/bigqueryconnection_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  bigqueryconnection.getProjectsLocationsConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a cloud resource connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { connection: created, live } = yield* stack.deploy(
        Effect.gen(function* () {
          const connection = yield* GCP.BigQueryConnection.Connection("Gcs", {
            location: "us-central1",
            friendlyName: "gcs-test",
            description: "cloud resource connection",
            cloudResource: {},
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* connection.name;
              const getConnection =
                yield* GCP.BigQueryConnection.GetConnection(connection);
              return Effect.fn(function* () {
                return yield* getConnection();
              });
            }),
          );
          return {
            connection,
            live: yield* Probe({}),
          };
        }),
      );

      expect(created.connectionId).toEqual(expect.any(String));
      expect(created.name).toContain("/connections/");
      expect(created.location).toEqual("us-central1");
      expect(created.kind).toEqual("cloudResource");
      expect(created.friendlyName).toEqual("gcs-test");
      expect(created.description).toEqual("cloud resource connection");
      expect(created.cloudResource).toEqual(expect.any(Object));
      expect(created.serviceAccountId).toEqual(expect.any(String));
      expect(live.name).toEqual(created.name);
      expect(live.cloudResource).toEqual(expect.any(Object));

      const fetched = yield* bigqueryconnection.getProjectsLocationsConnections(
        {
          name: created.name,
        },
      );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.friendlyName).toEqual("gcs-test");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("cloud resource connection");
      expect(fetched.cloudResource).toEqual(expect.any(Object));

      const listed = yield* bigqueryconnection.listProjectsLocationsConnections(
        {
          parent: `projects/${created.project}/locations/${created.location}`,
          pageSize: 100,
        },
      );
      expect(
        (listed.connections ?? []).some(
          (connection) => connection.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryConnection.Connection("Gcs", {
            connectionId: created.connectionId,
            location: "us-central1",
            friendlyName: "gcs-prod",
            description: "updated cloud resource",
            cloudResource: {},
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.connectionId).toEqual(created.connectionId);
      expect(updated.friendlyName).toEqual("gcs-prod");
      expect(updated.description).toEqual("updated cloud resource");
      expect(updated.kind).toEqual("cloudResource");
      expect(updated.creationTime).toEqual(created.creationTime);

      const fetchedUpdate =
        yield* bigqueryconnection.getProjectsLocationsConnections({
          name: updated.name,
        });
      expect(fetchedUpdate.friendlyName).toEqual("gcs-prod");
      expect(fetchedUpdate.description).toContain("updated cloud resource");

      const last = created.connectionId.at(-1) ?? "a";
      const nextConnectionId = `${created.connectionId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryConnection.Connection("Gcs", {
            connectionId: nextConnectionId,
            location: "us-central1",
            friendlyName: "gcs-replaced",
            description: "replaced connection",
            cloudResource: {},
          });
        }),
      );

      expect(replaced.connectionId).not.toEqual(created.connectionId);
      expect(replaced.connectionId).toEqual(nextConnectionId);
      expect(replaced.friendlyName).toEqual("gcs-replaced");
      expect(replaced.kind).toEqual("cloudResource");

      const fetchedReplace =
        yield* bigqueryconnection.getProjectsLocationsConnections({
          name: replaced.name,
        });
      expect(fetchedReplace.name).toEqual(replaced.name);
      expect(fetchedReplace.friendlyName).toEqual("gcs-replaced");

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryconnection", "live"],
    timeout: 90_000,
  },
);

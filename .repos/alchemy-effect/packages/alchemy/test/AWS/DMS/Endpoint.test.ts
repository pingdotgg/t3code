import * as AWS from "@/AWS";
import { Endpoint } from "@/AWS/DMS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dms from "@distilled.cloud/aws/database-migration-service";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findEndpoint = (identifier: string) =>
  dms
    .describeEndpoints({
      Filters: [{ Name: "endpoint-id", Values: [identifier] }],
    })
    .pipe(
      Effect.map((r) => r.Endpoints?.[0]),
      Effect.catchTag("ResourceNotFoundFault", () => Effect.succeed(undefined)),
    );

// Deletion is verified as gone or at least initiated (status `deleting`,
// which is irreversible). Full disappearance is eventually consistent.
const assertGone = (identifier: string) =>
  findEndpoint(identifier).pipe(
    Effect.map((endpoint) => endpoint?.Status ?? "gone"),
    Effect.flatMap((status) =>
      status === "gone" || status === "deleting"
        ? Effect.void
        : Effect.fail(new Error(`endpoint '${identifier}' status: ${status}`)),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

test.provider(
  "create, update, delete a DMS source endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create a MySQL source endpoint. DMS endpoints are metadata-only, so
      // no live database is required.
      const { endpoint } = yield* stack.deploy(
        Effect.gen(function* () {
          const endpoint = yield* Endpoint("Source", {
            endpointType: "source",
            engineName: "mysql",
            serverName: "source-db.example.com",
            port: 3306,
            username: "admin",
            password: Redacted.make("correct-horse-battery-staple"),
            databaseName: "app",
            tags: { team: "data" },
          });
          return { endpoint };
        }),
      );

      // DMS echoes the endpoint type back uppercased.
      expect(endpoint.endpointType).toBe("SOURCE");
      expect(endpoint.engineName).toBe("mysql");
      expect(endpoint.endpointArn).toContain(":endpoint:");
      expect(endpoint.tags.team).toBe("data");

      // Out-of-band verification via distilled.
      const observed = yield* findEndpoint(endpoint.endpointIdentifier);
      expect(observed?.EndpointArn).toBe(endpoint.endpointArn);
      expect(observed?.ServerName).toBe("source-db.example.com");
      expect(observed?.Port).toBe(3306);

      // Update: change port + username and one tag.
      const { endpoint: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const endpoint = yield* Endpoint("Source", {
            endpointType: "source",
            engineName: "mysql",
            serverName: "source-db.example.com",
            port: 3307,
            username: "readonly",
            databaseName: "app",
            tags: { team: "platform" },
          });
          return { endpoint };
        }),
      );

      // Same endpoint (in-place modify).
      expect(updated.endpointArn).toBe(endpoint.endpointArn);
      const observed2 = yield* findEndpoint(endpoint.endpointIdentifier);
      expect(observed2?.Port).toBe(3307);
      expect(observed2?.Username).toBe("readonly");
      expect(updated.tags.team).toBe("platform");

      yield* stack.destroy();
      yield* assertGone(endpoint.endpointIdentifier);
    }),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { endpoint } = yield* stack.deploy(
        Effect.gen(function* () {
          const endpoint = yield* Endpoint("ListTarget", {
            endpointType: "target",
            engineName: "postgres",
            serverName: "target-db.example.com",
            port: 5432,
            username: "admin",
            password: Redacted.make("hunter2"),
            databaseName: "warehouse",
          });
          return { endpoint };
        }),
      );

      const provider = yield* Provider.findProvider(Endpoint);
      const all = yield* provider.list();
      expect(all.some((e) => e.endpointArn === endpoint.endpointArn)).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertGone(endpoint.endpointIdentifier);
    }),
  { timeout: 240_000 },
);

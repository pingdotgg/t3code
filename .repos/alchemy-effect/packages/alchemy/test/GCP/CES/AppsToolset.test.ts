import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ces from "@distilled.cloud/gcp/ces_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const pingSchema = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Ping", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const waitUntilGone = (name: string) =>
  ces.getProjectsLocationsAppsToolsets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppsToolsets on a missing toolset fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsToolsets({
          name: `projects/${project}/locations/us/apps/missing/toolsets/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

test.provider(
  "create, update, and delete a toolset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            location: "us",
            displayName: "support-toolset",
          });
          const toolset = yield* GCP.CES.AppsToolset("Ping", {
            app: app.name,
            displayName: "ping",
            description: "ping endpoints",
            openApiToolset: { openApiSchema: pingSchema },
          });
          return { app, toolset };
        }),
      );

      expect(created.toolset.name).toContain("/toolsets/");
      expect(created.toolset.app).toEqual(created.app.name);
      expect(created.toolset.displayName).toEqual("ping");
      expect(created.toolset.description).toEqual("ping endpoints");
      expect(created.toolset.openApiToolset?.openApiSchema).toBeDefined();

      const fetched = yield* ces.getProjectsLocationsAppsToolsets({
        name: created.toolset.name,
      });
      expect(fetched.name).toEqual(created.toolset.name);
      // The description reaches the model: no ownership marker.
      expect(fetched.description).toEqual("ping endpoints");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support-toolset",
          });
          const toolset = yield* GCP.CES.AppsToolset("Ping", {
            app: app.name,
            toolsetId: created.toolset.toolsetId,
            displayName: "ping",
            description: "ping and health",
            openApiToolset: { openApiSchema: pingSchema },
          });
          return { app, toolset };
        }),
      );

      expect(updated.toolset.name).toEqual(created.toolset.name);
      expect(updated.toolset.description).toEqual("ping and health");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.toolset.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

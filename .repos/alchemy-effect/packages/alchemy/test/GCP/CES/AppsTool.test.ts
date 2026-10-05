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

const waitUntilGone = (name: string) =>
  ces.getProjectsLocationsAppsTools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppsTools on a missing tool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsTools({
          name: `projects/${project}/locations/us/apps/missing/tools/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

test.provider(
  "create, update, and delete a tool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            location: "us",
            displayName: "support-tool",
          });
          const tool = yield* GCP.CES.AppsTool("Lookup", {
            app: app.name,
            clientFunction: {
              name: "lookup_order",
              description: "Look up an order.",
              parameters: {
                type: "OBJECT",
                properties: { orderId: { type: "STRING" } },
              },
            },
          });
          return { app, tool };
        }),
      );

      expect(created.tool.name).toContain("/tools/");
      expect(created.tool.app).toEqual(created.app.name);
      expect(created.tool.clientFunction?.name).toEqual("lookup_order");
      expect(created.tool.clientFunction?.description).toEqual(
        "Look up an order.",
      );

      const fetched = yield* ces.getProjectsLocationsAppsTools({
        name: created.tool.name,
      });
      expect(fetched.name).toEqual(created.tool.name);
      // The description tells the model when to call the tool: no marker.
      expect(fetched.clientFunction?.description).toEqual("Look up an order.");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support-tool",
          });
          const tool = yield* GCP.CES.AppsTool("Lookup", {
            app: app.name,
            toolId: created.tool.toolId,
            clientFunction: {
              name: "lookup_order",
              description: "Look up an order by id.",
              parameters: {
                type: "OBJECT",
                properties: {
                  orderId: { type: "STRING" },
                  includeHistory: { type: "BOOLEAN" },
                },
              },
            },
          });
          return { app, tool };
        }),
      );

      expect(updated.tool.name).toEqual(created.tool.name);
      expect(updated.tool.clientFunction?.description).toEqual(
        "Look up an order by id.",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.tool.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

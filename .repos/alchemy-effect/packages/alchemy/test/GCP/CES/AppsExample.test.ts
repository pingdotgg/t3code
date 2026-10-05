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
  ces.getProjectsLocationsAppsExamples({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppsExamples on a missing example fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsExamples({
          name: `projects/${project}/locations/us/apps/missing/examples/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

test.provider(
  "create, update, and delete an example",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            location: "us",
            displayName: "support-example",
          });
          const example = yield* GCP.CES.AppsExample("Hello", {
            app: app.name,
            displayName: "hello",
            description: "greeting",
            messages: [
              { role: "user", chunks: [{ text: "Hi" }] },
              { role: "agent", chunks: [{ text: "Hello!" }] },
            ],
          });
          return { app, example };
        }),
      );

      expect(created.example.name).toContain("/examples/");
      expect(created.example.app).toEqual(created.app.name);
      expect(created.example.displayName).toEqual("hello");
      expect(created.example.description).toEqual("greeting");
      expect(created.example.messages?.length).toEqual(2);

      const fetched = yield* ces.getProjectsLocationsAppsExamples({
        name: created.example.name,
      });
      expect(fetched.name).toEqual(created.example.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support-example",
          });
          const example = yield* GCP.CES.AppsExample("Hello", {
            app: app.name,
            exampleId: created.example.exampleId,
            displayName: "hello",
            description: "greeting with help",
            messages: [
              { role: "user", chunks: [{ text: "Hi" }] },
              {
                role: "agent",
                chunks: [{ text: "Hello! How can I help?" }],
              },
            ],
          });
          return { app, example };
        }),
      );

      expect(updated.example.name).toEqual(created.example.name);
      expect(updated.example.description).toEqual("greeting with help");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.example.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

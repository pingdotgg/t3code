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
  ces.getProjectsLocationsAppsAgents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppsAgents on a missing agent fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsAgents({
          name: `projects/${project}/locations/us/apps/missing/agents/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

test.provider(
  "create, update, and delete an agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            location: "us",
            displayName: "support-agent",
          });
          const agent = yield* GCP.CES.AppsAgent("Greeter", {
            app: app.name,
            displayName: "greeter",
            description: "greets callers",
            instruction: "Greet the user.",
          });
          return { app, agent };
        }),
      );

      expect(created.agent.name).toContain("/agents/");
      expect(created.agent.app).toEqual(created.app.name);
      expect(created.agent.displayName).toEqual("greeter");
      expect(created.agent.description).toEqual("greets callers");
      expect(created.agent.instruction).toEqual("Greet the user.");

      const fetched = yield* ces.getProjectsLocationsAppsAgents({
        name: created.agent.name,
      });
      expect(fetched.name).toEqual(created.agent.name);
      // The description reaches the model: no ownership marker.
      expect(fetched.description).toEqual("greets callers");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support-agent",
          });
          const agent = yield* GCP.CES.AppsAgent("Greeter", {
            app: app.name,
            agentId: created.agent.agentId,
            displayName: "greeter",
            description: "greets and routes",
            instruction: "Greet the user and offer help.",
          });
          return { app, agent };
        }),
      );

      expect(updated.agent.name).toEqual(created.agent.name);
      expect(updated.agent.description).toEqual("greets and routes");
      expect(updated.agent.instruction).toEqual(
        "Greet the user and offer help.",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.agent.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

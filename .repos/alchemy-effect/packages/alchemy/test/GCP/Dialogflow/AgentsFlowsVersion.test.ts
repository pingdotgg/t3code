import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { deleteAgent, ensureAgent, quotaTolerant } from "./parent.ts";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsFlowsVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsFlowsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsFlowsVersions({
          name: `projects/${project}/locations/global/agents/alchemy-missing/flows/alchemy-missing/versions/999999`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a flow version",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const agent = yield* ensureAgent(project, "alchemy-df-version");

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const flow = yield* GCP.Dialogflow.AgentsFlow("Main", {
              agent: agent.name ?? "",
              displayName: "main",
            });
            const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: flow.name,
              displayName: "v1",
              description: "initial snapshot",
            });
            return { flow, version };
          }),
        );

        expect(created.version.name).toContain("/versions/");
        expect(created.version.displayName).toEqual("v1");
        expect(created.version.description).toEqual("initial snapshot");
        expect(["SUCCEEDED", "RUNNING", undefined]).toContain(
          created.version.state,
        );

        const fetched =
          yield* dialogflow.getProjectsLocationsAgentsFlowsVersions({
            name: created.version.name,
          });
        expect(fetched.name).toEqual(created.version.name);
        expect(fetched.description).toContain("[alchemy ");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const flow = yield* GCP.Dialogflow.AgentsFlow("Main", {
              agent: agent.name ?? "",
              flowId: created.flow.flowId,
              displayName: "main",
            });
            const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: flow.name,
              versionId: created.version.versionId,
              displayName: "v1-ga",
              description: "ga snapshot",
            });
            return { flow, version };
          }),
        );

        expect(updated.version.name).toEqual(created.version.name);
        expect(updated.version.displayName).toEqual("v1-ga");
        expect(updated.version.description).toEqual("ga snapshot");

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.version.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);

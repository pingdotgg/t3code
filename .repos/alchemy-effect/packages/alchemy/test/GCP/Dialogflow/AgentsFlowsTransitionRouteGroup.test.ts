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
  dialogflow
    .getProjectsLocationsAgentsFlowsTransitionRouteGroups({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsAgentsFlowsTransitionRouteGroups on a missing route group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsFlowsTransitionRouteGroups({
          name: `projects/${project}/locations/global/agents/alchemy-missing/flows/alchemy-missing/transitionRouteGroups/alchemy-missing`,
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
  "create, update, and delete a transition route group",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const agent = yield* ensureAgent(project, "alchemy-df-trg");

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const flow = yield* GCP.Dialogflow.AgentsFlow("Main", {
              agent: agent.name ?? "",
              displayName: "main",
            });
            const group = yield* GCP.Dialogflow.AgentsFlowsTransitionRouteGroup(
              "Fallback",
              {
                flow: flow.name,
                displayName: "fallback",
                transitionRoutes: [
                  {
                    condition: "true",
                    triggerFulfillment: {
                      messages: [{ text: { text: ["ok"] } }],
                    },
                  },
                ],
              },
            );
            return { flow, group };
          }),
        );

        expect(created.group.name).toContain("/transitionRouteGroups/");
        expect(created.group.displayName).toEqual("fallback");
        expect(created.group.transitionRoutes.length).toBeGreaterThan(0);

        const fetched =
          yield* dialogflow.getProjectsLocationsAgentsFlowsTransitionRouteGroups(
            {
              name: created.group.name,
            },
          );
        expect(fetched.name).toEqual(created.group.name);
        expect(fetched.displayName).toMatch(/^\[(alchemy|alc) /);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const flow = yield* GCP.Dialogflow.AgentsFlow("Main", {
              agent: agent.name ?? "",
              flowId: created.flow.flowId,
              displayName: "main",
            });
            const group = yield* GCP.Dialogflow.AgentsFlowsTransitionRouteGroup(
              "Fallback",
              {
                flow: flow.name,
                transitionRouteGroupId: created.group.transitionRouteGroupId,
                displayName: "defaults",
                transitionRoutes: [
                  {
                    condition: "true",
                    triggerFulfillment: {
                      messages: [{ text: { text: ["all good"] } }],
                    },
                  },
                ],
              },
            );
            return { flow, group };
          }),
        );

        expect(updated.group.name).toEqual(created.group.name);
        expect(updated.group.displayName).toEqual("defaults");

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.group.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);

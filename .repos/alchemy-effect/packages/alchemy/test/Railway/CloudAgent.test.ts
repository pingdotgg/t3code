import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloud agents are Priority Boarding. Unentitled workspaces reject
// `cloudAgentCreate` with a typed plan/auth tag. The probe always runs
// and pins that tag. When the token is entitled the same test continues
// through the resource create+list+delete lifecycle.

const listLive = (environmentId: string) =>
  railway
    .cloudAgents({ environmentId, mine: true })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed([]),
      ),
    );

const waitUntilAgentGone = (environmentId: string, cloudAgentId: string) =>
  listLive(environmentId).pipe(
    Effect.map((items) =>
      items.some(
        (agent) => agent.id === cloudAgentId && agent.status !== "DELETING",
      )
        ? ("found" as const)
        : ("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const deleteAgent = (id: string) =>
  railway
    .cloudAgentDelete({ id })
    .pipe(Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void));

test.provider(
  "create, list, and delete a cloud agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectOnly = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          return { project, environment };
        }),
      );

      const probe = yield* Effect.result(
        railway.cloudAgentCreate({
          input: {
            environmentId: projectOnly.environment.environmentId,
            name: projectOnly.project.name,
          },
        }),
      );
      if (Result.isFailure(probe)) {
        expect(
          ["RailwayForbidden", "RailwayPlanLimitExceeded"].includes(
            probe.failure._tag,
          ),
        ).toEqual(true);
        yield* stack.destroy();
        return;
      }

      yield* deleteAgent(probe.success.id);
      yield* waitUntilAgentGone(
        projectOnly.environment.environmentId,
        probe.success.id,
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const agent = yield* Railway.CloudAgent("Coder", {
            environment,
          });
          return { project, environment, agent };
        }),
      );

      expect(created.agent.cloudAgentId).toEqual(expect.any(String));
      expect(created.agent.cloudAgentId.length).toBeGreaterThan(0);
      expect(created.agent.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.agent.projectId).toEqual(created.project.projectId);
      expect(created.agent.name).toEqual(expect.any(String));
      expect(created.agent.name.length).toBeGreaterThan(0);
      expect(created.agent.name.length).toBeLessThanOrEqual(32);
      expect(created.agent.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.agent.createdAt).toEqual(expect.any(String));
      expect(created.agent.status).toEqual(expect.any(String));
      expect(
        [
          "CRASHED",
          "DELETING",
          "FAILED",
          "RUNNING",
          "SLEEPING",
          "STARTING",
        ].includes(created.agent.status),
      ).toEqual(true);

      const listed = yield* listLive(created.environment.environmentId);
      const fetched = listed.find(
        (agent) => agent.id === created.agent.cloudAgentId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.name).toEqual(created.agent.name);
      expect(fetched?.environmentId).toEqual(created.environment.environmentId);
      expect(fetched?.projectId).toEqual(created.project.projectId);

      const provider = yield* Provider.findProvider(Railway.CloudAgent);
      const fromProvider = yield* provider.list();
      const found = fromProvider.find(
        (agent) => agent.cloudAgentId === created.agent.cloudAgentId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.agent.name);
      expect(found?.environmentId).toEqual(created.environment.environmentId);

      yield* stack.destroy();

      const agentGone = yield* waitUntilAgentGone(
        created.environment.environmentId,
        created.agent.cloudAgentId,
      );
      expect(agentGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

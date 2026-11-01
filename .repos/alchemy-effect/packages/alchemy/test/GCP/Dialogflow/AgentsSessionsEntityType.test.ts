import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  deleteAgent,
  deleteEntityType,
  ensureAgent,
  ensureEntityType,
  quotaTolerant,
} from "./parent.ts";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;
const agentDisplayName = "alch-df-set";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsSessionsEntityTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsSessionsEntityTypes on a missing session entity type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsSessionsEntityTypes({
          name: `projects/${project}/locations/global/agents/missing/sessions/alchemy/entityTypes/sys.color`,
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
  "create, update, and delete a session entity type",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName);
      const agentName = agent.name ?? "";
      const entityType = yield* ensureEntityType(agentName, "colors");
      const entityTypeId = (entityType.name ?? "").split("/").pop() ?? "colors";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsSessionsEntityType("Colors", {
            agent: agentName,
            sessionId: "alchemy",
            entityTypeId,
            entityOverrideMode: "ENTITY_OVERRIDE_MODE_OVERRIDE",
            entities: [
              { value: "cerulean", synonyms: ["cerulean", "blue-green"] },
            ],
          });
        }),
      );

      expect(created.name).toContain("/entityTypes/");
      expect(created.agent).toEqual(agentName);
      expect(created.sessionId).toEqual("alchemy");
      expect(created.entityTypeId).toEqual(entityTypeId);
      expect(
        created.entities.some((entity) => entity.value === "cerulean"),
      ).toEqual(true);

      const fetched =
        yield* dialogflow.getProjectsLocationsAgentsSessionsEntityTypes({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsSessionsEntityType("Colors", {
            agent: agentName,
            sessionId: "alchemy",
            entityTypeId,
            entityOverrideMode: "ENTITY_OVERRIDE_MODE_OVERRIDE",
            entities: [
              { value: "cerulean", synonyms: ["cerulean"] },
              { value: "scarlet", synonyms: ["scarlet", "red"] },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(
        updated.entities.some((entity) => entity.value === "scarlet"),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");

      yield* deleteEntityType(entityType.name ?? "");
      yield* deleteAgent(agentName);
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);

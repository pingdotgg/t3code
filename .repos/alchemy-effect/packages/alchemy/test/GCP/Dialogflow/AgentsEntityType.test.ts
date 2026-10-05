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
  dialogflow.getProjectsLocationsAgentsEntityTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsEntityTypes on a missing entity type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsEntityTypes({
          name: `projects/${project}/locations/global/agents/alchemy-missing/entityTypes/alchemy-missing`,
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
  "create, update, and delete an entity type",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const agent = yield* ensureAgent(project, "alchemy-df-entitytype");

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsEntityType("Color", {
              agent: agent.name ?? "",
              displayName: "color",
              kind: "KIND_MAP",
              entities: [{ value: "red", synonyms: ["red", "scarlet"] }],
            });
          }),
        );

        expect(created.name).toContain("/entityTypes/");
        expect(created.displayName).toEqual("color");
        expect(created.kind).toEqual("KIND_MAP");
        expect(created.entities).toEqual(
          expect.arrayContaining([expect.objectContaining({ value: "red" })]),
        );

        const fetched = yield* dialogflow.getProjectsLocationsAgentsEntityTypes(
          {
            name: created.name,
          },
        );
        expect(fetched.name).toEqual(created.name);
        expect(fetched.displayName).toEqual("color");
        expect(fetched.excludedPhrases ?? []).toEqual([]);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsEntityType("Color", {
              agent: agent.name ?? "",
              entityTypeId: created.entityTypeId,
              displayName: "color",
              kind: "KIND_MAP",
              entities: [
                { value: "red", synonyms: ["red", "scarlet", "crimson"] },
              ],
            });
          }),
        );

        expect(updated.name).toEqual(created.name);
        expect(
          updated.entities.some((entity) =>
            (entity.synonyms ?? []).includes("crimson"),
          ),
        ).toEqual(true);

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);

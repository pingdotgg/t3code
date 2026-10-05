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
    .getProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({ name })
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
  "getProjectsLocationsAgentsEnvironmentsSessionsEntityTypes on a missing session entity type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({
          name: `projects/${project}/locations/global/agents/alchemy-missing/environments/alchemy-missing/sessions/alchemy-missing/entityTypes/alchemy-missing`,
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
      const agent = yield* ensureAgent(project, "alchemy-df-session-et");
      const startFlow = agent.startFlow ?? "";

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const color = yield* GCP.Dialogflow.AgentsEntityType("Color", {
              agent: agent.name ?? "",
              displayName: "color",
              kind: "KIND_MAP",
              entities: [{ value: "red", synonyms: ["red"] }],
            });
            const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: startFlow,
              displayName: "v1",
              description: "session snapshot",
            });
            const environment = yield* GCP.Dialogflow.AgentsEnvironment(
              "Prod",
              {
                agent: agent.name ?? "",
                displayName: "prod",
                versionConfigs: [{ version: version.name }],
              },
            );
            const session =
              yield* GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType(
                "SessionColor",
                {
                  environment: environment.name,
                  entityType: color.name,
                  entityOverrideMode: "ENTITY_OVERRIDE_MODE_OVERRIDE",
                  entities: [{ value: "blue", synonyms: ["blue", "navy"] }],
                },
              );
            return { color, version, environment, session };
          }),
        );

        expect(created.session.name).toContain("/sessions/");
        expect(created.session.name).toContain("/entityTypes/");
        expect(created.session.entityOverrideMode).toEqual(
          "ENTITY_OVERRIDE_MODE_OVERRIDE",
        );
        expect(created.session.entities).toEqual(
          expect.arrayContaining([expect.objectContaining({ value: "blue" })]),
        );

        const fetched =
          yield* dialogflow.getProjectsLocationsAgentsEnvironmentsSessionsEntityTypes(
            { name: created.session.name },
          );
        expect(fetched.name).toEqual(created.session.name);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const color = yield* GCP.Dialogflow.AgentsEntityType("Color", {
              agent: agent.name ?? "",
              entityTypeId: created.color.entityTypeId,
              displayName: "color",
              kind: "KIND_MAP",
              entities: [{ value: "red", synonyms: ["red"] }],
            });
            const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: startFlow,
              versionId: created.version.versionId,
              displayName: "v1",
              description: "session snapshot",
            });
            const environment = yield* GCP.Dialogflow.AgentsEnvironment(
              "Prod",
              {
                agent: agent.name ?? "",
                environmentId: created.environment.environmentId,
                displayName: "prod",
                versionConfigs: [{ version: version.name }],
              },
            );
            const session =
              yield* GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType(
                "SessionColor",
                {
                  environment: environment.name,
                  entityType: color.name,
                  sessionId: created.session.sessionId,
                  entityOverrideMode: "ENTITY_OVERRIDE_MODE_OVERRIDE",
                  entities: [
                    { value: "blue", synonyms: ["blue", "navy", "azure"] },
                  ],
                },
              );
            return { color, version, environment, session };
          }),
        );

        expect(updated.session.name).toEqual(created.session.name);
        expect(
          updated.session.entities.some((entity) =>
            (entity.synonyms ?? []).includes("azure"),
          ),
        ).toEqual(true);

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.session.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);

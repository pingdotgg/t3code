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
// Non-global Dialogflow CX locations need the {region}-dialogflow host, which
// distilled does not route to yet; the global location works everywhere.
const location = "global";
const agentDisplayName = "alch-df-wh";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsWebhooks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsWebhooks on a missing webhook fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsWebhooks({
          name: `projects/${project}/locations/${location}/agents/missing/webhooks/missing`,
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
  "create, update, and delete a webhook",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName, location);
      const agentName = agent.name ?? "";

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsWebhook("Fulfillment", {
              agent: agentName,
              location,
              displayName: "orders",
              genericWebService: { uri: "https://example.com/dialogflow" },
            });
          }),
        );

        expect(created.name).toContain("/webhooks/");
        expect(created.agent).toEqual(agentName);
        expect(created.location).toEqual(location);
        expect(created.displayName).toEqual("orders");
        expect(created.disabled).toEqual(false);
        expect(created.genericWebService?.uri).toEqual(
          "https://example.com/dialogflow",
        );

        const fetched = yield* dialogflow.getProjectsLocationsAgentsWebhooks({
          name: created.name,
        });
        expect(fetched.name).toEqual(created.name);
        expect(fetched.displayName).toMatch(/^\[(alchemy|alc) /);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsWebhook("Fulfillment", {
              agent: agentName,
              location,
              webhookId: created.webhookId,
              displayName: "orders-v2",
              disabled: true,
              genericWebService: {
                uri: "https://example.com/dialogflow-v2",
              },
            });
          }),
        );

        expect(updated.name).toEqual(created.name);
        expect(updated.displayName).toEqual("orders-v2");
        expect(updated.disabled).toEqual(true);
        expect(updated.genericWebService?.uri).toEqual(
          "https://example.com/dialogflow-v2",
        );

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agentName)));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);

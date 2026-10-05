import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const LOCATION = "us-central1";
const PUBSUB_EVENT_TYPE = "google.cloud.pubsub.topic.v1.messagePublished";
const WORKFLOW_SOURCE = `main:
  params: [event]
  steps:
    - return_event:
        return: \${event}
`;

const waitUntilGone = (name: string) =>
  eventarc.getProjectsLocationsTriggers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const eventFilters: GCP.Eventarc.EventFilter[] = [
  { attribute: "type", value: PUBSUB_EVENT_TYPE },
];

test.provider(
  "create, update, and delete an Eventarc trigger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            labels: { env: "test" },
          });
          const workflow = yield* GCP.Workflows.Workflow("Sink", {
            location: LOCATION,
            sourceContents: WORKFLOW_SOURCE,
            labels: { env: "test" },
          });
          const trigger = yield* GCP.Eventarc.Trigger("PubSubEvents", {
            location: LOCATION,
            eventFilters,
            destination: { workflow: workflow.name },
            transport: { pubsub: { topic: topic.name } },
            labels: { env: "test" },
          });
          return { topic, workflow, trigger };
        }),
      );

      expect(created.trigger.name).toContain("/triggers/");
      expect(created.trigger.triggerId).toEqual(expect.any(String));
      expect(created.trigger.location).toEqual(LOCATION);
      expect(created.trigger.labels).toMatchObject({ env: "test" });
      expect(created.trigger.eventFilters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attribute: "type",
            value: PUBSUB_EVENT_TYPE,
          }),
        ]),
      );
      expect(created.trigger.destination?.workflow).toEqual(
        created.workflow.name,
      );
      expect(created.trigger.transport?.pubsub?.topic).toEqual(
        created.topic.name,
      );

      const fetched = yield* eventarc.getProjectsLocationsTriggers({
        name: created.trigger.name,
      });
      expect(fetched.name).toEqual(created.trigger.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.destination?.workflow).toEqual(created.workflow.name);
      expect(fetched.transport?.pubsub?.topic).toEqual(created.topic.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          const workflow = yield* GCP.Workflows.Workflow("Sink", {
            workflowId: created.workflow.workflowId,
            location: LOCATION,
            sourceContents: WORKFLOW_SOURCE,
            labels: { env: "test" },
          });
          return yield* GCP.Eventarc.Trigger("PubSubEvents", {
            triggerId: created.trigger.triggerId,
            location: LOCATION,
            eventFilters,
            destination: { workflow: workflow.name },
            transport: { pubsub: { topic: topic.name } },
            eventDataContentType: "application/json",
            labels: { env: "prod", role: "events" },
          });
        }),
      );

      expect(updated.name).toEqual(created.trigger.name);
      expect(updated.triggerId).toEqual(created.trigger.triggerId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "events" });
      expect(updated.eventDataContentType).toEqual("application/json");

      const refetched = yield* eventarc.getProjectsLocationsTriggers({
        name: created.trigger.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("events");
      expect(
        refetched.eventDataContentType === undefined ||
          refetched.eventDataContentType === "application/json",
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.trigger.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 120_000 },
);

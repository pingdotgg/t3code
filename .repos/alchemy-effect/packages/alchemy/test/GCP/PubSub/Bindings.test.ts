import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { callProbe, dockerAvailable, expectProbe } from "../bindingHost.ts";
import PubSubBindingsHost, {
  EventSchema,
  PUBLISH_PAYLOAD,
  PublishTap,
  PublishTopic,
  PullInbox,
  PullTopic,
  ReadInbox,
  ReadTopic,
  WRITE_BATCH_BYTES,
  WRITE_BATCH_TEXT,
  WRITE_PAYLOAD,
  WriteTap,
  WriteTopicTarget,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PubSubBindings");

let baseUrl: string;
let member: string;
let names: {
  publishTopic: string;
  publishTap: string;
  writeTopic: string;
  writeTap: string;
  pullTopic: string;
  pullInbox: string;
  readTopic: string;
  readInbox: string;
  schema: string;
};

const decode = (data: string | undefined) =>
  Buffer.from(data ?? "", "base64").toString("utf8");

/** Roles `member` holds on a resource's IAM policy. */
const rolesOf = (
  policy: { bindings?: { role?: string; members?: string[] }[] },
  member: string,
) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort();

/** Pull (out of band) until `count` messages arrived, acknowledging them. */
const drain = (subscription: string, count: number) =>
  Effect.gen(function* () {
    const seen: pubsub.ReceivedMessage[] = [];
    yield* pubsub
      .pullProjectsSubscriptions({
        subscription,
        body: { maxMessages: 10, returnImmediately: false },
      })
      .pipe(
        Effect.tap((page) =>
          Effect.gen(function* () {
            const received = page.receivedMessages ?? [];
            seen.push(...received);
            if (received.length > 0) {
              yield* pubsub.acknowledgeProjectsSubscriptions({
                subscription,
                body: { ackIds: received.map((m) => m.ackId ?? "") },
              });
            }
          }),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: () => seen.length >= count,
          times: 30,
        }),
      );
    return seen;
  });

/** Publish (out of band, as the deployer) one message. */
const publishOutOfBand = (topic: string, text: string) =>
  pubsub.publishProjectsTopics({
    topic,
    body: { messages: [{ data: Buffer.from(text).toString("base64") }] },
  });

/** Nothing is redelivered once the ack deadline (10s) has passed. */
const expectNoRedelivery = (subscription: string) =>
  Effect.gen(function* () {
    yield* Effect.sleep("15 seconds");
    const page = yield* pubsub.pullProjectsSubscriptions({
      subscription,
      body: { maxMessages: 10, returnImmediately: true },
    });
    expect(page.receivedMessages ?? []).toEqual([]);
  });

describe.skipIf(!dockerAvailable)(
  "PubSub Bindings",
  { tags: ["provider:gcp", "provider:gcp:pubsub", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* PubSubBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              publishTopic: (yield* PublishTopic).name,
              publishTap: (yield* PublishTap).name,
              writeTopic: (yield* WriteTopicTarget).name,
              writeTap: (yield* WriteTap).name,
              pullTopic: (yield* PullTopic).name,
              pullInbox: (yield* PullInbox).name,
              readTopic: (yield* ReadTopic).name,
              readInbox: (yield* ReadInbox).name,
              schema: (yield* EventSchema).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        names = out;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Publish", () => {
      test.provider(
        "publishes to the topic, granted publisher on the topic only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ messageIds?: string[] }>(
              baseUrl,
              "publish",
            );
            expect(out.messageIds).toHaveLength(1);

            const [message] = yield* drain(names.publishTap, 1);
            expect(message?.message?.messageId).toEqual(out.messageIds?.[0]);
            expect(decode(message?.message?.data)).toEqual(PUBLISH_PAYLOAD);
            expect(message?.message?.attributes).toEqual({ via: "Publish" });

            const policy = yield* pubsub.getIamPolicyProjectsTopics({
              resource: names.publishTopic,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.publisher"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("Pull / Acknowledge", () => {
      test.provider(
        "pulls and acknowledges, granted subscriber on the subscription only",
        (_stack) =>
          Effect.gen(function* () {
            yield* publishOutOfBand(names.pullTopic, "pull-me");
            const texts = yield* expectProbe<string[]>(
              baseUrl,
              "pullAndAcknowledge",
            );
            expect(texts).toEqual(["pull-me"]);
            yield* expectNoRedelivery(names.pullInbox);

            const policy = yield* pubsub.getIamPolicyProjectsSubscriptions({
              resource: names.pullInbox,
            });
            expect(rolesOf(policy, member)).toEqual([
              "roles/pubsub.subscriber",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteTopic", () => {
      test.provider(
        "publish and publishBatch, granted publisher on the topic only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              id: string;
              batch: string[];
              empty: string[];
            }>(baseUrl, "writeTopic");
            expect(out.batch).toHaveLength(2);
            // An empty batch is a no-op, not a request.
            expect(out.empty).toEqual([]);

            // Out of band: every message landed with its payload intact.
            const received = yield* drain(names.writeTap, 3);
            const byId = new Map(
              received.map((m) => [m.message?.messageId, m.message]),
            );
            expect(decode(byId.get(out.id)?.data)).toEqual(WRITE_PAYLOAD);
            expect(byId.get(out.id)?.attributes).toEqual({ via: "WriteTopic" });
            expect(decode(byId.get(out.batch[0])?.data)).toEqual(
              WRITE_BATCH_TEXT,
            );
            expect([
              ...Buffer.from(byId.get(out.batch[1])?.data ?? "", "base64"),
            ]).toEqual(WRITE_BATCH_BYTES);

            const policy = yield* pubsub.getIamPolicyProjectsTopics({
              resource: names.writeTopic,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.publisher"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadSubscription", () => {
      test.provider(
        "pull, modifyAckDeadline and acknowledge, granted subscriber on the subscription only",
        (_stack) =>
          Effect.gen(function* () {
            yield* publishOutOfBand(names.readTopic, "read-me");
            const messages = yield* expectProbe<
              { text: string; attributes: Record<string, string> }[]
            >(baseUrl, "readSubscription");
            expect(messages).toEqual([{ text: "read-me", attributes: {} }]);
            yield* expectNoRedelivery(names.readInbox);

            const policy = yield* pubsub.getIamPolicyProjectsSubscriptions({
              resource: names.readInbox,
            });
            expect(rolesOf(policy, member)).toEqual([
              "roles/pubsub.subscriber",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetSchema", () => {
      test.provider(
        "reads the schema, granted viewer on the schema",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<pubsub.Pubsub_Schema>(
              baseUrl,
              "getSchema",
            );
            expect(live.name).toEqual(names.schema);
            expect(live.type).toEqual("AVRO");
            expect(JSON.parse(live.definition ?? "{}")).toMatchObject({
              name: "Event",
            });

            const policy = yield* pubsub.getIamPolicyProjectsSchemas({
              resource: names.schema,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.viewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ValidateMessage", () => {
      test.provider(
        "accepts a conforming message and rejects another, granted viewer on the project",
        (_stack) =>
          Effect.gen(function* () {
            const valid = yield* expectProbe<object>(baseUrl, "validateValid");
            expect(valid).toEqual({});

            const invalid = yield* callProbe(baseUrl, "validateInvalid");
            expect(invalid.ok ? "ok" : invalid.error._tag).toEqual(
              "BadRequest",
            );

            const { project } = yield* GcpEnvironment.current;
            const policy = yield* resourcemanager.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            // schemas.validateMessage is authorized on the parent project
            // (a viewer grant on the schema alone answers 403).
            expect(
              (policy.bindings ?? [])
                .filter((binding) => (binding.members ?? []).includes(member))
                .map((binding) => [binding.role, binding.condition]),
            ).toEqual([["roles/pubsub.viewer", undefined]]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);

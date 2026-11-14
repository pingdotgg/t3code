import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (name: string) =>
  pubsub.getProjectsSubscriptions({ subscription: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const getSubscription = (name: string) =>
  pubsub.getProjectsSubscriptions({ subscription: name }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const pullUntilMessage = (name: string) =>
  pubsub
    .pullProjectsSubscriptions({
      subscription: name,
      body: { maxMessages: 1, returnImmediately: true },
    })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (response) => (response.receivedMessages?.length ?? 0) > 0,
        times: 10,
      }),
    );

test.provider(
  "create, update, and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            topic: topic.name,
            labels: { env: "test" },
          });
          return { topic, subscription };
        }),
      );

      expect(created.subscription.name).toContain("/subscriptions/");
      expect(created.subscription.subscriptionId).toEqual(expect.any(String));
      expect(created.subscription.topic).toEqual(created.topic.name);
      expect(created.subscription.labels).toMatchObject({ env: "test" });
      expect(created.subscription.ackDeadlineSeconds).toEqual(10);

      const fetched = yield* getSubscription(created.subscription.name);
      expect(fetched.name).toEqual(created.subscription.name);
      expect(fetched.topic).toEqual(created.topic.name);
      expect(fetched.labels?.env).toEqual("test");

      yield* pubsub.publishProjectsTopics({
        topic: created.topic.name,
        body: { messages: [{ data: btoa("hello-pubsub") }] },
      });

      const pulled = yield* pullUntilMessage(created.subscription.name);
      const received = pulled.receivedMessages ?? [];
      expect(received.length).toBeGreaterThan(0);
      const ackId = received[0]?.ackId;
      expect(ackId).toEqual(expect.any(String));
      if (ackId !== undefined) {
        yield* pubsub.acknowledgeProjectsSubscriptions({
          subscription: created.subscription.name,
          body: { ackIds: [ackId] },
        });
      }

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            subscriptionId: created.subscription.subscriptionId,
            topic: topic.name,
            labels: { env: "prod", role: "orders" },
            ackDeadlineSeconds: 30,
            messageRetentionDuration: "86400s",
          });
          return { topic, subscription };
        }),
      );

      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.topic).toEqual(created.topic.name);
      expect(updated.subscription.labels).toMatchObject({
        env: "prod",
        role: "orders",
      });
      expect(updated.subscription.ackDeadlineSeconds).toEqual(30);
      expect(updated.subscription.messageRetentionDuration).toEqual("86400s");

      const fetchedUpdated = yield* getSubscription(updated.subscription.name);
      expect(fetchedUpdated.ackDeadlineSeconds).toEqual(30);
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("orders");
      expect(fetchedUpdated.messageRetentionDuration).toEqual("86400s");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subscription.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 90_000 },
);

test.provider(
  "dead-letters a message after maxDeliveryAttempts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("DlqSource", {});
          const deadLetters = yield* GCP.PubSub.Topic("DlqTarget", {});
          const inbox = yield* GCP.PubSub.Subscription("DlqInbox", {
            topic: deadLetters.name,
          });
          const subscription = yield* GCP.PubSub.Subscription("DlqWork", {
            topic: topic.name,
            deadLetterPolicy: {
              deadLetterTopic: deadLetters.name,
              maxDeliveryAttempts: 5,
            },
          });
          return {
            topic: topic.name,
            deadLetters: deadLetters.name,
            inbox: inbox.name,
            subscription: subscription.name,
          };
        }),
      );

      // The Pub/Sub service agent forwards dead letters, so it must be
      // able to publish to the target and ack on the source subscription.
      const topicPolicy = yield* pubsub.getIamPolicyProjectsTopics({
        resource: out.deadLetters,
      });
      const agent = (topicPolicy.bindings ?? [])
        .find((binding) => binding.role === "roles/pubsub.publisher")
        ?.members?.find((member) => member.includes("@gcp-sa-pubsub."));
      expect(agent).toBeDefined();
      const subscriptionPolicy = yield* pubsub.getIamPolicyProjectsSubscriptions({
        resource: out.subscription,
      });
      expect(
        (subscriptionPolicy.bindings ?? []).some(
          (binding) =>
            binding.role === "roles/pubsub.subscriber" && binding.members?.includes(agent!),
        ),
      ).toBe(true);

      yield* pubsub.publishProjectsTopics({
        topic: out.topic,
        body: { messages: [{ data: btoa("poison") }] },
      });

      // Pull and nack until Pub/Sub gives up on the message.
      const nackOnce = pubsub
        .pullProjectsSubscriptions({
          subscription: out.subscription,
          body: { maxMessages: 1, returnImmediately: true },
        })
        .pipe(
          Effect.tap(({ receivedMessages = [] }) => {
            const ackIds = receivedMessages.flatMap((m) => (m.ackId ? [m.ackId] : []));
            return ackIds.length === 0
              ? Effect.void
              : pubsub.modifyAckDeadlineProjectsSubscriptions({
                  subscription: out.subscription,
                  body: { ackIds, ackDeadlineSeconds: 0 },
                });
          }),
        );
      const deadLetter = pubsub
        .pullProjectsSubscriptions({
          subscription: out.inbox,
          body: { maxMessages: 1, returnImmediately: true },
        })
        .pipe(Effect.map(({ receivedMessages = [] }) => receivedMessages[0]));

      const letter = yield* nackOnce.pipe(
        Effect.andThen(deadLetter),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (message) => message !== undefined,
          times: 60,
        }),
      );
      expect(atob(letter!.message?.data ?? "")).toEqual("poison");
      expect(letter!.message?.attributes?.CloudPubSubDeadLetterSourceSubscription).toEqual(
        out.subscription.split("/").pop(),
      );

      yield* stack.destroy();
      expect(yield* waitUntilGone(out.subscription)).toEqual("gone");
      expect(yield* waitUntilGone(out.inbox)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 240_000 },
);

const tableWriters = (table: { project: string; datasetId: string; tableId: string }) =>
  bigquery
    .getIamPolicyTables({
      resource: `projects/${table.project}/datasets/${table.datasetId}/tables/${table.tableId}`,
      body: {},
    })
    .pipe(
      Effect.map(
        (policy) =>
          policy.bindings?.find((binding) => binding.role === "roles/bigquery.dataEditor")
            ?.members ?? [],
      ),
    );

// `projects/-/` answers 403 for a deleted account; the project id gets 404.
const serviceAccountExists = (email: string) =>
  iam
    .getProjectsServiceAccounts({
      name: `projects/${email.split("@")[1]!.split(".")[0]}/serviceAccounts/${email}`,
    })
    .pipe(
      Effect.as(true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
    );

// IAM reads lag deletes: poll until the account stops being served.
const waitUntilServiceAccountGone = (email: string) =>
  serviceAccountExists(email).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (exists) => !exists,
      times: 15,
    }),
  );

test.provider(
  "writes messages to a BigQuery table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bigqueryStack = (bigqueryConfig?: { writeMetadata: boolean }) =>
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Impressions", {});
          const dataset = yield* GCP.BigQuery.Dataset("ImpressionsRaw", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("ImpressionEvent", {
            datasetId: dataset.datasetId,
            schema: [
              { name: "subscription_name", type: "STRING" },
              { name: "message_id", type: "STRING" },
              { name: "publish_time", type: "TIMESTAMP" },
              { name: "data", type: "STRING" },
              { name: "attributes", type: "STRING" },
            ],
          });
          const subscription = yield* GCP.PubSub.Subscription("ImpressionsBigQuery", {
            topic: topic.name,
            bigqueryConfig:
              bigqueryConfig === undefined ? undefined : { table: table.name, ...bigqueryConfig },
          });
          return { topic, table, subscription };
        });

      // Pub/Sub writes as an account the subscription mints and grants on
      // the table: nothing in the stack names a principal or a policy.
      const created = yield* stack.deploy(bigqueryStack({ writeMetadata: true }));
      const tableRef = `${created.table.project}.${created.table.datasetId}.${created.table.tableId}`;
      const writer = created.subscription.bigqueryConfig?.serviceAccountEmail;
      expect(created.subscription.bigqueryConfig).toMatchObject({
        table: tableRef,
        useTopicSchema: false,
        useTableSchema: false,
        writeMetadata: true,
        dropUnknownFields: false,
        serviceAccountEmail: expect.stringMatching(/^alch-.+\.iam\.gserviceaccount\.com$/),
      });
      expect(yield* tableWriters(created.table)).toContain(`serviceAccount:${writer}`);

      const fetched = yield* getSubscription(created.subscription.name);
      expect(fetched.bigqueryConfig?.table).toEqual(tableRef);
      expect(fetched.bigqueryConfig?.serviceAccountEmail).toEqual(writer);

      const published = yield* pubsub.publishProjectsTopics({
        topic: created.topic.name,
        body: { messages: [{ data: btoa("impression-1") }] },
      });
      const messageId = published.messageIds?.[0];
      expect(messageId).toEqual(expect.any(String));

      const rows = yield* bigquery
        .queryJobs({
          projectId: created.table.project,
          body: {
            query: `SELECT DISTINCT data, message_id FROM ${created.table.datasetId}.${created.table.tableId}`,
            useLegacySql: false,
            location: created.table.location,
          },
        })
        .pipe(
          Effect.map(({ rows = [] }) => rows.map((row) => row.f?.map((cell) => cell.v))),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (rows) => rows.length > 0,
            times: 30,
          }),
        );
      expect(rows).toEqual([["impression-1", messageId]]);

      const updated = yield* stack.deploy(bigqueryStack({ writeMetadata: false }));
      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.bigqueryConfig).toMatchObject({
        table: tableRef,
        writeMetadata: false,
        serviceAccountEmail: writer,
      });
      const fetchedUpdated = yield* getSubscription(updated.subscription.name);
      expect(fetchedUpdated.bigqueryConfig?.writeMetadata ?? false).toBe(false);

      // Dropping bigqueryConfig turns it back into a pull subscription and
      // revokes the writer's grant; the writer lives as long as the
      // subscription, so turning BigQuery back on reuses it.
      const pull = yield* stack.deploy(bigqueryStack());
      expect(pull.subscription.name).toEqual(created.subscription.name);
      expect(pull.subscription.bigqueryConfig).toBeUndefined();
      expect((yield* getSubscription(pull.subscription.name)).bigqueryConfig?.table ?? "").toEqual(
        "",
      );
      expect(yield* tableWriters(pull.table)).not.toContain(`serviceAccount:${writer}`);
      expect(yield* serviceAccountExists(writer!)).toBe(true);

      // Destroying the subscription deletes its writer.
      const again = yield* stack.deploy(bigqueryStack({ writeMetadata: false }));
      expect(again.subscription.bigqueryConfig?.serviceAccountEmail).toEqual(writer);
      expect(yield* tableWriters(again.table)).toContain(`serviceAccount:${writer}`);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.subscription.name)).toEqual("gone");
      expect(yield* waitUntilServiceAccountGone(writer!)).toBe(false);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 360_000 },
);

const accountTokenCreators = (account: { project: string; email: string }) =>
  iam
    .getIamPolicyProjectsServiceAccounts({
      resource: `projects/${account.project}/serviceAccounts/${account.email}`,
    })
    .pipe(
      Effect.map(
        (policy) =>
          policy.bindings?.find(
            (binding) => binding.role === "roles/iam.serviceAccountTokenCreator",
          )?.members ?? [],
      ),
    );

test.provider(
  "writes to BigQuery as a service account the stack provides",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const writerStack = (subscribe?: { asAccount: boolean }) =>
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Clicks", {});
          const dataset = yield* GCP.BigQuery.Dataset("ClicksRaw", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("ClickEvent", {
            datasetId: dataset.datasetId,
            schema: [{ name: "data", type: "STRING" }],
          });
          const account = yield* GCP.IAM.ServiceAccount("ClicksWriter", {});
          // The account already writes to the table for its own reasons:
          // the subscription uses that grant and must never revoke it.
          yield* GCP.IAM.Member("ClicksWriterTable", {
            kind: "bigquery.table",
            name: table.name,
            role: "roles/bigquery.dataEditor",
            member: Output.interpolate`serviceAccount:${account.email}`,
          });
          const subscription =
            subscribe === undefined
              ? undefined
              : yield* GCP.PubSub.Subscription("ClicksBigQuery", {
                  topic: topic.name,
                  bigqueryConfig: {
                    table: table.name,
                    serviceAccountEmail: subscribe.asAccount ? account.email : undefined,
                  },
                });
          return { topic, table, account, subscription };
        });

      yield* stack.deploy(writerStack());

      const given = yield* stack.deploy(writerStack({ asAccount: true }));
      const account = given.account;
      const agentMember = (members: readonly string[]) =>
        members.find((member) => member.includes("@gcp-sa-pubsub."));
      expect(given.subscription?.bigqueryConfig?.serviceAccountEmail).toEqual(account.email);
      expect(agentMember(yield* accountTokenCreators(account))).toBeDefined();
      // Only the token-creator grant is the subscription's; the table grant
      // was already there.
      expect(given.subscription?.iamGrants?.map((grant) => grant.role)).toEqual([
        "roles/iam.serviceAccountTokenCreator",
      ]);

      const published = yield* pubsub.publishProjectsTopics({
        topic: given.topic.name,
        body: { messages: [{ data: btoa("click-1") }] },
      });
      const rows = yield* bigquery
        .queryJobs({
          projectId: given.table.project,
          body: {
            query: `SELECT DISTINCT data FROM ${given.table.datasetId}.${given.table.tableId}`,
            useLegacySql: false,
            location: given.table.location,
          },
        })
        .pipe(
          Effect.map(({ rows = [] }) => rows.map((row) => row.f?.map((cell) => cell.v))),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (rows) => rows.length > 0,
            times: 30,
          }),
        );
      expect(published.messageIds?.length).toEqual(1);
      expect(rows).toEqual([["click-1"]]);

      // Switching to a minted writer revokes what the subscription granted
      // on the account and keeps what the account already held.
      const minted = yield* stack.deploy(writerStack({ asAccount: false }));
      expect(minted.subscription?.name).toEqual(given.subscription?.name);
      expect(minted.subscription?.bigqueryConfig?.serviceAccountEmail).not.toEqual(account.email);
      expect(agentMember(yield* accountTokenCreators(account))).toBeUndefined();
      expect(yield* tableWriters(minted.table)).toContain(`serviceAccount:${account.email}`);
      expect(yield* serviceAccountExists(account.email)).toBe(true);

      yield* stack.destroy();
      expect(yield* waitUntilGone(given.subscription!.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 360_000 },
);

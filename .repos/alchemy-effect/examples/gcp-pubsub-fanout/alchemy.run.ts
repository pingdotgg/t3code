import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Analytics from "./src/Analytics.ts";
import Email from "./src/Email.ts";
import Orders from "./src/Orders.ts";
import {
  DeadOrderEvents,
  DeadOrderEventsInbox,
  OrderEvents,
  OrderEventsTable,
  Outbox,
} from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpPubSubFanoutExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const topic = yield* OrderEvents;
    const deadLetters = yield* DeadOrderEvents;
    const inbox = yield* DeadOrderEventsInbox;
    const outbox = yield* Outbox;
    const table = yield* OrderEventsTable;
    const orders = yield* Orders;
    const email = yield* Email;
    const analytics = yield* Analytics;

    return {
      url: orders.uri,
      project: orders.project,
      topicName: topic.name,
      deadLetterTopicName: deadLetters.name,
      deadLetterSubscription: inbox.name,
      bucketName: outbox.bucketName,
      tableName: table.name,
      emailService: email.name,
      analyticsService: analytics.name,
    };
  }),
);

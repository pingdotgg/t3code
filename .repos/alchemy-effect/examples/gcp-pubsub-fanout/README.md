# gcp-pubsub-fanout

Event fan-out on Cloud Run with Pub/Sub push. A public orders API
publishes one event per order change to a single topic. Two private
consumers subscribe to it independently: one sends confirmation emails,
the other records every event in BigQuery. Emails that can never be sent
are dead-lettered instead of retried forever.

```
                          ┌─ type = "order.created" ──> Email ──> gs://…/emails/:eventId.json
POST /orders ──> Orders ──> OrderEvents                  │ 5 failed attempts
POST /orders/:id/cancel   │                             v
                          │                      DeadOrderEvents ──> DeadOrderEventsInbox
                          └─ every event ──> Analytics ──> BigQuery order_events
```

- `src/resources.ts` — the `OrderEvents` topic, the `DeadOrderEvents`
  topic and its `DeadOrderEventsInbox` pull subscription, the `Outbox`
  bucket, and the `Warehouse` dataset with its `order_events` table.
- `src/Orders.ts` — public `GCP.Function`, the producer:
  - `POST /orders` `{ email, total }` publishes `order.created`.
  - `POST /orders/:id/cancel` `{ email }` publishes `order.cancelled`.
  - Both return `202 { orderId, eventId }`. The event type is also set as
    the message's `type` attribute, which is what subscription filters
    match on.
- `src/Email.ts` — private `GCP.Function`. Its subscription filters on
  `attributes.type = "order.created"`, so Pub/Sub never pushes it any
  other event type. It writes one "sent email" object per event to the
  outbox. Mail to a `.invalid` address always fails; after 5 attempts
  Pub/Sub forwards the event to `DeadOrderEvents`.
- `src/Analytics.ts` — private `GCP.Function` with no filter. It inserts a
  row for every event, using the event id as the BigQuery `insertId` so a
  redelivery does not duplicate it.

Adding a third consumer is one more `consumeTopicMessages` on the topic;
the producer does not change.

## Bindings and event sources

| Host      | Binding / event source                                                  | IAM granted                                                                                                                               |
| --------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Orders    | `GCP.PubSub.WriteTopic(OrderEvents)`                                    | `roles/pubsub.publisher` on the topic, to the host's service account                                                                      |
| Email     | `GCP.Storage.WriteBucket(Outbox)`                                       | `roles/storage.objectUser` on the bucket, to the host's service account                                                                   |
| Email     | `GCP.PubSub.consumeTopicMessages(OrderEvents, { filter, deadLetter })` | `roles/run.invoker` on Email, to its own service account; `roles/pubsub.publisher` on `DeadOrderEvents` and `roles/pubsub.subscriber` on the push subscription, to the Pub/Sub service agent |
| Analytics | `GCP.BigQuery.WriteTable(OrderEventsTable)`                             | `roles/bigquery.dataEditor` on the table, to the host's service account                                                                   |
| Analytics | `GCP.PubSub.consumeTopicMessages(OrderEvents)`                          | `roles/run.invoker` on Analytics, to its own service account                                                                              |

Both consumers use `GCP.Run.TopicEventSource`, the push implementation.
Each call creates its own push subscription on the topic, pointed at
`/__alchemy/pubsub/orderevents` on the consuming service and signed with
an OIDC token for that service's runtime account. The runtime verifies the
token before the handler runs, so the consumers stay private. A handler
that fails answers `500`, and Pub/Sub redelivers.

The dead-letter option:

```ts
yield* GCP.PubSub.consumeTopicMessages(
  orders,
  {
    filter: 'attributes.type = "order.created"',
    deadLetter: { topic: deadOrders, maxDeliveryAttempts: 5 },
  },
  handler,
);
```

With `deadLetter` set, the subscription also gets a 10s–600s exponential
retry backoff (override it with `retryPolicy`). Without it, Pub/Sub
redelivers a failed push almost at once, and all 5 attempts could be spent
in the seconds a fresh deploy's `run.invoker` grant takes to propagate,
dead-lettering good orders.

Pub/Sub forwards dead letters as the project's service agent
(`service-{projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`); the
subscription grants it the two roles it needs. A topic with no
subscription drops what it receives, which is why the dead-letter topic
has `DeadOrderEventsInbox`. Dead letters keep their original attributes
and gain `CloudPubSubDeadLetterSourceSubscription`.

## Deploy

Requires Docker (the services are built from `main`). Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

```sh
pnpm deploy --profile <name>
```

```sh
curl -X POST "$url/orders" -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","total":42}'
curl -X POST "$url/orders/$orderId/cancel" -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'
gcloud storage ls "gs://$bucketName/emails/"
gcloud pubsub subscriptions pull "$deadLetterSubscription" --auto-ack
```

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack and checks both push subscriptions (filter, dead-letter
policy, the service agent's grants). It then places orders and waits for
each one's email object in Cloud Storage and its row in BigQuery; cancels
an order and checks the cancellation reaches BigQuery but not the email
consumer; and places an order to a `.invalid` address and pulls it from
the dead-letter subscription. Finally it destroys the stack and checks the
services, subscriptions, topics, bucket, and dataset are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```

The bucket and dataset use `forceDestroy: true`, so destroy removes their
contents too. Drop it for real data.

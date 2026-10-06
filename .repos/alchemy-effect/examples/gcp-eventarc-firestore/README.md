# Firestore change events with Eventarc

A public API writes orders to Firestore; a private Cloud Run service reacts to every new order through Eventarc and writes an audit entry. The API never calls the auditor. New reactions can be added without touching the API.

## What it builds

- [`Shop`](./src/resources.ts): a named Firestore database in Native mode, in `LOCATION` (`us-central1`).
- [`Api`](./src/Api.ts): a public `GCP.Function`. `POST /orders` with `{ item, quantity }` creates `orders/{id}`.
- [`Auditor`](./src/Auditor.ts): a private `GCP.Function`. An Eventarc trigger sends it `google.cloud.firestore.document.v1.created` events for `orders/{id}` in `Shop`, and it writes `audit/{id}` for each one.

The trigger filters on:

| attribute  | value                                        | operator             |
| ---------- | -------------------------------------------- | -------------------- |
| `type`     | `google.cloud.firestore.document.v1.created` | exact                |
| `database` | the `Shop` database id                       | exact                |
| `document` | `orders/{id}`                                | `match-path-pattern` |

Eventarc only delivers Firestore events to triggers in the database's own location. For that reason the database and the trigger both use `LOCATION`; the services run in the stack's region.

Firestore events are `application/protobuf` (`DocumentEventData`), so the handler gets `event.data` as a `Uint8Array`. The CloudEvent attributes already name the document (`event.attributes.document === "orders/{id}"`, `event.subject === "documents/orders/{id}"`). That is enough for an audit trail. If a reaction needs the document's fields, it can decode the protobuf or read the document back by path.

## Bindings, event sources, and IAM

| Used by | Binding / event source                                       | Grants to the service's runtime account                                                                                                                               |
| ------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Api     | `GCP.Firestore.WriteDatabase` (`WriteDatabaseHttp`)          | `roles/datastore.user` on the project, with an IAM Condition limiting it to `Shop`                                                                                    |
| Auditor | `GCP.Firestore.WriteDatabase` (`WriteDatabaseHttp`)          | `roles/datastore.user` on the project, with an IAM Condition limiting it to `Shop`                                                                                    |
| Auditor | `GCP.Eventarc.consumeEvents` (`GCP.Run.EventarcEventSource`) | `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on `Auditor`. Also creates the trigger, using that account as the trigger identity. |

Every delivery carries an OIDC token for the Auditor's own service account, and the event source checks it before the handler runs. If the handler fails, the event source answers 500 and Eventarc redelivers the event. The auditor uses `create`, so a redelivered event finds its audit entry already written and does nothing.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

From the repository root:

```sh
pnpm install
cd examples/gcp-eventarc-firestore
pnpm deploy --profile <name>
```

Docker must be running, because both services are built locally from `main`.

```sh
curl -X POST "$URL/orders" -H 'content-type: application/json' \
  -d '{"item":"widget","quantity":2}'
```

After a few seconds, `audit/{id}` shows up in the database. On a first deploy, two things can take a few minutes to settle: project-level Firestore grants have to propagate, and Eventarc has to start routing to the new trigger. An order created during that window may never be audited.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test --timeout 1200000
```

[The test](./test/integ.test.ts) deploys the stack and checks the trigger's filters. It then creates two orders and polls Firestore until each one has an audit entry. At the end it destroys the stack and confirms that the trigger and the database are gone.

A new trigger can take a couple of minutes after it reports healthy before Eventarc routes events to it. Any document created in that window produces no event. To wait this out, the test creates throwaway probe orders until one of them is audited, and only then makes the orders it asserts on.

## Destroy

```sh
pnpm destroy --profile <name>
```

This deletes both services, the trigger, the IAM grants, and the database with all of its documents.

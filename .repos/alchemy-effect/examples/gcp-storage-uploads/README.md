# gcp-storage-uploads

An upload pipeline on Cloud Run. A public API stores files in Cloud
Storage; a private indexer picks each upload up from the bucket's
notification, hashes it, and records its metadata in Firestore.

```
PUT /files/:name ──> Api ──> gs://…/uploads/:name
                                   │ OBJECT_FINALIZE
                                   v
                         Pub/Sub push ──> Indexer ──> Firestore files/:name
GET /files ─────────> Api <────────────────────────── (size, type, sha256)
```

- `src/resources.ts` — the `Uploads` bucket and the `Files` Firestore
  database (named, `FIRESTORE_NATIVE`).
- `src/Api.ts` — public `GCP.Function`:
  - `PUT /files/:name` stores the body at `uploads/:name` and returns `202`.
  - `GET /files/:name` returns the stored bytes.
  - `GET /files` lists the indexed metadata.
  - `DELETE /files/:name` deletes the object and its metadata.
- `src/Indexer.ts` — private `GCP.Function` consuming `OBJECT_FINALIZE`
  events for `uploads/`. It reads the exact object generation the event
  names, computes its sha256, and writes `files/:name`. Uploads never wait
  on the hash.

## Bindings and event sources

| Host    | Binding / event source                    | IAM granted to the host's service account                            |
| ------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Api     | `GCP.Storage.ReadBucket(bucket)`          | `roles/storage.objectViewer` on the bucket                           |
| Api     | `GCP.Storage.WriteBucket(bucket)`         | `roles/storage.objectUser` on the bucket                             |
| Api     | `GCP.Firestore.ReadWriteDatabase(files)`  | `roles/datastore.user` on the project, conditioned on this database  |
| Indexer | `GCP.Storage.ReadBucket(bucket)`          | `roles/storage.objectViewer` on the bucket                           |
| Indexer | `GCP.Firestore.WriteDatabase(files)`      | `roles/datastore.user` on the project, conditioned on this database  |
| Indexer | `GCP.Storage.consumeBucketEvents(bucket)` | `roles/run.invoker` on the Indexer itself (for the push OIDC token)  |

`consumeBucketEvents` is provided by `GCP.Storage.BucketEventSourceLive`
with `GCP.Run.TopicEventSource` for delivery. Together they create a
Pub/Sub topic, a `JSON_API_V1` bucket notification filtered to
`OBJECT_FINALIZE` under `uploads/` (granting the Cloud Storage service
agent `roles/pubsub.publisher` on the topic), and a push subscription that
calls the Indexer with an OIDC token for its own service account.

Firestore databases have no resource-level IAM policy, so the Firestore
roles are granted on the project under an IAM Condition that names the
`Files` database.

## Deploy

Requires Docker (the services are built from `main`). Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

```sh
pnpm deploy --profile <name>
```

```sh
curl -X PUT --data-binary @photo.jpg -H 'content-type: image/jpeg' "$url/files/photo.jpg"
curl "$url/files"            # metadata appears once the indexer has run
curl -o out.jpg "$url/files/photo.jpg"
curl -X DELETE "$url/files/photo.jpg"
```

On a fresh deploy the project-level Firestore grants can take a few
minutes to propagate. Until then the indexer's writes fail and Pub/Sub
redelivers them, so metadata shows up late rather than never.

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack, uploads a text file and a random binary, reads both
back, waits for the indexer's records, checks each sha256 against the
uploaded bytes and each record against the live Firestore document and
object generation, deletes a file, then destroys the stack and checks the
bucket, database, and services are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```

The bucket uses `forceDestroy: true`, so destroy removes its objects too.
Drop it for real user data.

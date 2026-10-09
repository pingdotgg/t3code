# gcp-cloud-function

A public JSON notes API on an Effect-native 2nd-gen Cloud Function, backed by
Firestore.

| Route               | Does                              |
| ------------------- | --------------------------------- |
| `POST /notes`       | create a note from `{ title, body }` |
| `GET /notes`        | list notes                        |
| `GET /notes/:id`    | read one note                     |
| `DELETE /notes/:id` | delete a note                     |

## Architecture

- `src/Notes.ts` — `GCP.CloudFunctions.Function` with `main: import.meta.url`.
  Alchemy bundles it for Node.js 22, uploads the archive, and serves `fetch`
  through the Functions Framework. No Dockerfile, no local image build.
- `src/resources.ts` — a named `FIRESTORE_NATIVE` `GCP.Firestore.Database` in
  the stack's region. Each note is a document at `notes/{id}`.
- `alchemy.run.ts` — the stack, plus a `GCP.IAM.Member` that makes the
  function public.

## Bindings and IAM

| Binding                                                          | Grants                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GCP.Firestore.ReadWriteDatabase` (`ReadWriteDatabaseHttp`)      | `roles/datastore.user` to the function's runtime service account, on the project under an IAM Condition matching only `NotesDb` |
| `GCP.IAM.Member("PublicInvoker", …)` on the function's Cloud Run service | `roles/run.invoker` to `allUsers`                         |

Alchemy mints a dedicated runtime service account for the function; the
Firestore grant goes to that account only. Firestore databases have no
resource-level IAM policy, so the grant sits on the project with the
condition `resource.name == "<db>" || resource.name.startsWith("<db>/")`.

Drop the `PublicInvoker` member to keep the function private — callers then
need a Google identity token.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

```sh
pnpm deploy --profile <name>
```

The first deploy takes a few minutes: Cloud Build builds the function and
Firestore provisions the database. A fresh Firestore grant can take a few
more minutes to propagate, during which the API answers `500`.

```sh
curl -X POST "$url/notes" -H 'content-type: application/json' \
  -d '{"title":"groceries","body":"eggs, milk"}'
curl "$url/notes"
```

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack, drives the full CRUD cycle over HTTP, checks the
document in Firestore directly, then destroys the stack and verifies the
function and database are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```

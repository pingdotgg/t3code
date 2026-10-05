# Link shortener on Cloud Run

A public link shortener: one Cloud Run container, Firestore for state, and Secret Manager for the API key that guards writes. Every IAM grant comes from a binding, so nothing is wired by hand.

```sh
curl -X POST "$URL/links" -H "x-api-key: my-key" -H 'content-type: application/json' -d '{"url":"https://alchemy.run"}'
# 201 {"code":"aZ3k9Qx","shortUrl":"https://…/l/aZ3k9Qx"}
curl -i "$URL/l/aZ3k9Qx"
# 302 location: https://alchemy.run
curl "$URL/links/aZ3k9Qx"
# 200 {"code":"aZ3k9Qx","url":"https://alchemy.run","clicks":1,…}
```

## Architecture

- [`Links`](./src/resources.ts) — named Firestore Native database; one document per link at `links/{code}`.
- [`ApiKey`](./src/resources.ts) — Secret Manager secret holding the key callers send as `x-api-key`. Alchemy creates the secret; adding a version with the value is an operator step.
- [`Api`](./src/Api.ts) — public `GCP.Function` (a Cloud Run service):
  - `GET /` — health check.
  - `POST /links` — mint a 7-character base62 code for a URL (requires `x-api-key`).
  - `GET /l/:code` — `302` to the target and count the click.
  - `GET /links/:code` — read the link back.
  - `DELETE /links/:code` — retire a code (requires `x-api-key`).

Until the secret has a version, `POST /links` answers `503` instead of accepting any key.

## Bindings and IAM

| Host | Binding                                                                  | IAM granted to the host's service account                                        |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Api  | `GCP.Firestore.ReadWriteDatabase(Links)` + `ReadWriteDatabaseHttp`       | `roles/datastore.user` on the project, with an IAM Condition limiting it to `Links` |
| Api  | `GCP.SecretManager.ReadSecret(ApiKey)` + `ReadSecretHttp`                | `roles/secretmanager.secretAccessor` on the `ApiKey` secret only                 |

Firestore databases have no resource-level IAM policy, so the Firestore grant is project-level under an IAM Condition on the database name. It can take a few minutes to propagate after the first deploy; until then writes fail with `500`.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

From the repository root:

```sh
pnpm install
cd examples/gcp-cloud-run-api
pnpm deploy --profile <name>
```

Docker must be running, because the service is built locally from `main`. Then add the API key:

```sh
printf 'my-key' | gcloud secrets versions add "<secretId output>" --data-file=-
```

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test --timeout 1200000
```

[The test](./test/integ.test.ts) deploys the stack, adds a secret version, and checks the health route. It verifies that creates without the right key get `401`, then mints a link, confirms the Firestore document out of band, follows the redirect, checks the click count, and deletes the link. At the end it destroys the stack.

## Destroy

```sh
pnpm destroy --profile <name>
```

This deletes the service, its IAM grants, the secret with all of its versions, and the database with all of its documents.

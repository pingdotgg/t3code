# gcp-cloud-sql-drizzle

A todo API on Cloud Run backed by Cloud SQL for PostgreSQL, queried with
Drizzle. The service reaches the database over Cloud Run's built-in Cloud
SQL Unix socket — no authorized networks, no VPC — and the Drizzle
migrations are applied at deploy time through the Cloud SQL Data API.

| Method   | Path            | Body                                     |
| -------- | --------------- | ---------------------------------------- |
| `GET`    | `/todos`        | —                                        |
| `POST`   | `/todos`        | `{ "id": "<uuid>", "title": "Ship it" }` |
| `GET`    | `/todos/<uuid>` | —                                        |
| `PATCH`  | `/todos/<uuid>` | `{ "done": true }`                       |
| `DELETE` | `/todos/<uuid>` | —                                        |

Invalid bodies and ids get `400`.

## Architecture

- `GCP.SQL.Instance` `Postgres` — PostgreSQL 17, `db-f1-micro`, zonal, no
  backups, Data API enabled. No authorized networks.
- `GCP.SQL.Database` `App` and `GCP.SQL.User` `App` — the application
  database and its built-in login.
- `Alchemy.Random` `AppPassword` — the user's password, generated once and
  kept in state.
- `GCP.SecretManager.LocationsSecret` `AppPassword` — a regional secret in
  the instance's region (`location: instance.region`) holding that password. The Data API only reads passwords
  from regional secrets in the instance's region.
- `Drizzle.Schema` `Schema` — regenerates `./migrations` with drizzle-kit
  when [`src/schema.ts`](./src/schema.ts) changes.
- `Alchemy.Action` `Migrate` ([`src/migrate.ts`](./src/migrate.ts)) — at
  deploy time, writes the password as the secret's latest version and
  applies pending migrations with `instances.executeSql`, recording them
  in `__alchemy_migrations`.
- `GCP.Function` `Api` ([`src/Api.ts`](./src/Api.ts)) — public Cloud Run
  service (`invokerIamDisabled: true`) running Drizzle over
  `/cloudsql/{connectionName}`. It depends on the `Migrate` output, so it
  only rolls out once the schema exists.

## Bindings

| Binding                                          | Where         | Grants                                                                                                   |
| ------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------- |
| `GCP.SQL.Connect(instance, { … })`               | `Api`         | `roles/cloudsql.client` on the project under an IAM Condition naming only `Postgres`; mounts its socket |
| ↳ reads `passwordSecret`                         | `Api`         | `roles/secretmanager.secretAccessor` on `AppPassword` only                                               |
| `GCP.SQL.ExecuteSql(instance)`                   | `Migrate`     | none — Actions run as the deploying identity                                                             |
| `GCP.SecretManager.ReadWriteSecret(secret)`      | `Migrate`     | none — Actions run as the deploying identity                                                             |

`GCP.SQL.Connect` adds the instance to the service's `cloudsql` volume, so
Cloud Run starts its Cloud SQL connector and the Postgres socket appears
at `/cloudsql/{project}:{region}:{instance}`. Each request reads the
password from Secret Manager and hands Drizzle a socket URL.

The deploying identity needs `cloudsql.instances.executeSql` (e.g.
`roles/cloudsql.admin`) and access to the secret.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

```sh
pnpm deploy --profile <name>
```

Creating the Cloud SQL instance takes 5–10 minutes. The stack prints the
service `url`.

```sh
curl -X POST "$URL/todos" -H 'content-type: application/json' \
  -d '{"id":"aaaaaaaa-0000-4000-8000-000000000001","title":"Ship it"}'
curl "$URL/todos"
```

A fresh service account's `cloudsql.client` grant can take a few minutes
to propagate; until then requests answer `500`.

## Changing the schema

Edit [`src/schema.ts`](./src/schema.ts) and deploy. `Drizzle.Schema`
writes a new migration under `./migrations` (commit it), `Migrate`
applies it, and the service rolls a new revision.

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack, checks through the Data API that the migration was
applied, drives create / read / update / list / delete over HTTP while
checking the rows directly in Cloud SQL, then destroys the stack and
checks that the instance, secret, and service are gone. Needs
Docker (the service image is built locally). Allow about 20 minutes.

## Destroy

```sh
pnpm destroy --profile <name>
```

Deletes the service, its image repository and service account, the
secret, the user, the database, and the instance (with its data). Cloud
SQL keeps a deleted instance's name reserved for about a week, so the
next deploy gets a freshly generated name.

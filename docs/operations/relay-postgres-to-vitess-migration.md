# Relay: PlanetScale Postgres → PlanetScale Vitess (MySQL) data migration

This runbook covers the one-time migration of the production relay database from PlanetScale
Postgres (`t3coderelay`, `us-west`, PS_20) to PlanetScale Vitess/MySQL (`t3coderelay-vitess`).

Everything infrastructural lives in IaC across three PRs; only the data replication itself is an
operational task:

| Phase        | PR                          | What it does                                                                                                                                                                                                                                               |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Provision | `relay/provision-vitess-db` | Adds `RelayMysqlDatabase` to the prod stack. Deploying it creates the empty Vitess database and applies `migrations/mysql/…_baseline` via the alchemy migration runner (bookkeeping in `relay_migrations` included). The worker keeps running on Postgres. |
| 2. Replicate | — (operational)             | One AWS DMS task copies data Postgres → PlanetScale directly and keeps CDC running.                                                                                                                                                                        |
| 3. Cutover   | the migration PR            | Ports the worker to mysql (schema, driver, repos) and flips Hyperdrive's origin to the Vitess runtime password. The Postgres database + role **stay in the stack** for rollback.                                                                           |
| 4. Teardown  | follow-up PR after soak     | Removes `RelayPostgresDatabase`/`RelayPostgresRuntimeRole` and `migrations/postgres` from the stack (the retained database is orphaned, then deleted in the console).                                                                                      |

The relay dataset is small, so the data phase follows PlanetScale's
[small-database Postgres → PlanetScale guide](https://planetscale.com/docs/vitess/imports/postgres-planetscale-migration-guide):
a single DMS task, no Aurora intermediate, no import tool. (The
[larger-database guide](https://planetscale.com/docs/vitess/imports/postgres-mysql-planetscale-migration-guide)
adds those hops only for fast imports of big datasets.) If even a DMS task feels like overkill, the
"dump-and-load" appendix trades it for a ~15-minute write freeze and no AWS at all.

## 0. Preconditions

- [ ] AWS account with DMS permissions and the AWS CLI authenticated (only needed for the DMS
      path). A host with `psql` and `mysql` clients for verification.
- [ ] Source Postgres must expose logical replication for DMS: `logical_replication = 1` and
      `pglogical` in `shared_preload_libraries`. These are managed settings on PlanetScale
      Postgres — confirm/enable them in the console (Settings → Parameters) or via support before
      scheduling anything.
- [ ] Verify the narrowed column bounds hold in production data. The MySQL schema turns several
      indexed `text` columns into `varchar(255)` (InnoDB cannot uniquely index unbounded TEXT):

      ```sql
      -- run against the Postgres prod branch; every max must be <= 255
      select max(length(push_token)), max(length(push_to_start_token)) from relay_mobile_devices;
      select max(length(activity_push_token)) from relay_live_activities;
      select max(length(hostname)), max(length(tunnel_name)) from relay_managed_endpoint_allocations;
      select max(length(environment_public_key)) from relay_environment_links;
      select max(length(environment_public_key)) from relay_environment_credentials;
      select max(length(environment_public_key)) from relay_agent_activity_rows;
      ```

      If anything exceeds 255, widen the column in `infra/relay/src/persistence/schema.ts` and
      regenerate the baseline migration first.

- [ ] No relay schema changes land while the migration is in flight.

## 1. Land and deploy the provisioning PR

Merge `relay/provision-vitess-db` (or deploy it to `prod` manually). The deploy creates
`t3coderelay-vitess` (`us-west`, PS_20), applies the checked-in baseline schema, and records it in
`relay_migrations` — nothing manual, no `pscale` involved. The worker is untouched and still runs
on Postgres.

Afterwards, confirm in the console that **safe migrations is OFF** on `main` (it is off by default
for non-imported databases): alchemy applies DDL over a direct connection, not deploy requests, and
future `migrations/mysql/*` files fail to apply while it is on.

The only non-IaC credential in this whole flow: DMS needs to authenticate against the target, so
mint a short-lived password for it (this is a migration-time secret, not infrastructure — it
expires on its own and never enters the stack):

```sh
pscale password create t3coderelay-vitess main dms-import --role readwriter --ttl 604800
```

## 2. Replicate with a single DMS task

Use PlanetScale's [postgres-planetscale scripts](https://github.com/planetscale/postgres-planetscale)
(review before running):

```sh
sh import.sh --identifier "T3RelayPgToVitess" \
  --source "${PG_USER}:${PG_PASSWORD}@${PG_HOST}/${PG_DB}/public" \
  --target "${PS_USER}:${PS_PASSWORD}@${PS_HOST}/t3coderelay-vitess"
```

Two things to check in the task configuration before starting it:

- **Target prep mode must be `DO_NOTHING`** (or at most `TRUNCATE_BEFORE_LOAD`). DMS's default
  `DROP_AND_CREATE` would replace the deploy-created tables with DMS's own inferred types and drop
  the indexes/varchar bounds the relay depends on.
- **Exclude `relay_migrations` from the table mappings.** The source table tracks the _Postgres_
  migration files; copying it would clobber the MySQL bookkeeping written by the provisioning
  deploy.

DMS handles the type conversions (`jsonb → json`, `boolean → tinyint(1)` as `t/f → 1/0`,
`integer → int`; all timestamps are ISO-8601 varchars and pass through). Resource provisioning
takes ~20 minutes; the copy itself is quick at our size. After the full load, CDC keeps the target
in sync. Verify row counts per table:

```sql
select 'relay_mobile_devices', count(*) from relay_mobile_devices
union all select 'relay_live_activities', count(*) from relay_live_activities
union all select 'relay_environment_links', count(*) from relay_environment_links
union all select 'relay_environment_credentials', count(*) from relay_environment_credentials
union all select 'relay_managed_endpoint_allocations', count(*) from relay_managed_endpoint_allocations
union all select 'relay_managed_tunnel_limits', count(*) from relay_managed_tunnel_limits
union all select 'relay_agent_activity_rows', count(*) from relay_agent_activity_rows
union all select 'relay_delivery_attempts', count(*) from relay_delivery_attempts
union all select 'relay_dpop_proofs', count(*) from relay_dpop_proofs;
```

Watch the task's CloudWatch logs for conversion errors. Leave CDC running until cutover.

## 3. Land the cutover PR

1. Pick a low-traffic window. The relay's writes are retry-friendly (device registrations,
   activity upserts, APNs bookkeeping), but anything written to Postgres between "stop DMS" and
   "new worker live" is lost — at our volume that window is seconds to a couple of minutes.
2. Stop the DMS task (CDC drained first: task statistics show no pending changes).
3. Merge the migration PR (CI deploys `prod` on push to `main`), or deploy manually:

   ```sh
   vp run --filter t3code-relay deploy -- --stage prod
   ```

   The deploy:
   - keeps owning the Postgres database + runtime role (unchanged, still in the stack);
   - updates `RelayMysqlDatabase` in place (same resource id as the provisioning PR; only
     `migrationsDir` moves to the mysql schema resource) and applies nothing — the baseline is
     already recorded in `relay_migrations`;
   - creates the runtime password (`RelayMysqlRuntimePassword`, role `readwriter`) and points the
     existing Hyperdrive config at the MySQL origin — this is the actual cutover.

4. Smoke-test: link an environment, register a device from the mobile app, confirm agent activity
   rows appear, and watch worker traces (Axiom `relay.*` spans) for
   `SqlError`/`EffectDrizzleQueryError`.

## 4. Rollback

Revert the cutover PR (or redeploy the previous `main` commit). Because the Postgres database and
role never left the stack, that deploy only flips Hyperdrive back to the Postgres origin — no
re-provisioning, no data steps. Writes made while Vitess was primary are lost (nothing replicates
back to Postgres); decide based on how long the new stack was live. The DMS task can be restarted
afterwards to re-sync for another attempt (with `TRUNCATE_BEFORE_LOAD`, since the target now has
stale rows).

## 5. Soak

Run on Vitess for an agreed period (suggest ≥1 week) before destroying anything. The Postgres
database keeps costing its cluster size during soak — that's the price of the rollback path.

## 6. Land the teardown PR

1. Tear down the DMS resources: `sh cleanup.sh --identifier "T3RelayPgToVitess"` (the `dms-import`
   password has expired on its own).
2. Take a final PlanetScale Postgres backup.
3. The teardown PR removes the `RelayPostgresDatabase`/`RelayPostgresRuntimeRole` block from
   `infra/relay/src/db.ts` and deletes `infra/relay/migrations/postgres/`. Deploying it orphans the
   retained database (Alchemy stops managing it; nothing is deleted).
4. Delete the `t3coderelay` Postgres database in the PlanetScale console.
5. Ask developers to redeploy personal stages: the next `deploy` replaces their Postgres
   branch/role resources with Vitess branch/password resources automatically.

## Appendix: dump-and-load (no DMS at all)

For the current data volume the DMS task can be replaced by a short write freeze:

1. Land + deploy the provisioning PR (step 1; skip the DMS password).
2. Freeze relay writes (announce a maintenance window; seconds-to-minutes of 5xx on
   registration/link endpoints is acceptable — clients retry).
3. Copy data table-by-table: `pg_dump --data-only --column-inserts` per table, transform to
   MySQL-compatible inserts (`t/f → 1/0` for booleans; JSON and ISO-timestamp varchars pass
   through; adjust identifier quoting), and load with `mysql` using a short-TTL `pscale password`.
   At these sizes a small script or `pgloader` both work.
4. Verify row counts (query in step 2 above), then land the cutover PR (step 3) and smoke-test.

Same rollback caveat: once traffic lands on Vitess, writes are not mirrored back to Postgres.

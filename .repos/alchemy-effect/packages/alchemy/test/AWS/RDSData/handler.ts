import * as Lambda from "@/AWS/Lambda";
import * as RDS from "@/AWS/RDS";
import * as RDSData from "@/AWS/RDSData";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { RDSDataInfra } from "./infra.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class RDSDataTestFunction extends Lambda.Function<Lambda.Function>()(
  "RDSDataTestFunction",
) {}

/**
 * Lambda fixture for the RDS Data API bindings.
 *
 * Provisions an isolated network (Aurora requires a DB subnet group spanning
 * two AZs), an ingress-free security group (the Data API is HTTP — the Lambda
 * never opens a socket to the cluster), and an Aurora Serverless v2 postgres
 * cluster with the Data API enabled plus a generated admin secret.
 *
 * One HTTP route per binding behavior; `Effect.orDie` once at the outer
 * handler. NOTE: `ExecuteSql` is deprecated (Aurora Serverless v1 era) and is
 * intentionally NOT exercised here.
 */
export default RDSDataTestFunction.make(
  {
    main,
    url: true,
    // Data API statements can take tens of seconds while the serverless
    // cluster scales from idle — keep the Lambda alive through that.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // Shared Aurora fixture infra (VPC, subnets, SGs, secret, cluster,
    // writer) — also yielded by the Drizzle IAM fixture; declarations
    // dedupe by logical ID.
    const { secret, cluster } = yield* RDSDataInfra;

    const options = { secret, database: "app" };

    const executeStatement = yield* RDSData.ExecuteStatement(cluster, options);
    const batchExecuteStatement = yield* RDSData.BatchExecuteStatement(
      cluster,
      options,
    );
    const beginTransaction = yield* RDSData.BeginTransaction(cluster, options);
    const commitTransaction = yield* RDSData.CommitTransaction(cluster, {
      secret,
    });
    const rollbackTransaction = yield* RDSData.RollbackTransaction(cluster, {
      secret,
    });
    // RDS.Connect resolves connection settings (endpoint + secret credentials)
    // — no socket is opened, so it is exercisable from this ingress-free
    // fixture alongside the Data API bindings.
    const connect = yield* RDS.Connect(cluster, { secret, database: "app" });

    const ClusterIdentifier = yield* cluster.dbClusterIdentifier;
    const ClusterArn = yield* cluster.dbClusterArn;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Deployment metadata so the test can verify cluster deletion
        // out-of-band after destroy.
        if (request.method === "GET" && pathname === "/meta") {
          const clusterIdentifier = yield* ClusterIdentifier;
          const clusterArn = yield* ClusterArn;
          return yield* HttpServerResponse.json({
            clusterIdentifier,
            clusterArn,
          });
        }

        // RDS.Connect binding: resolves host/port from the cluster endpoint
        // and credentials from the Secrets Manager secret. The password is
        // never echoed back — only its presence.
        if (request.method === "GET" && pathname === "/connect-info") {
          const info = yield* connect;
          return yield* HttpServerResponse.json({
            host: info.host,
            port: info.port,
            database: info.database,
            username: info.username,
            hasPassword:
              typeof info.password === "string" && info.password.length > 0,
            ssl: info.ssl,
          });
        }

        // Cheap readiness probe (also proves ExecuteStatement end-to-end).
        if (request.method === "GET" && pathname === "/health") {
          const result = yield* executeStatement({ sql: "SELECT 1" });
          return yield* HttpServerResponse.json({
            records: result.records ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/setup") {
          const result = yield* executeStatement({
            sql: "CREATE TABLE IF NOT EXISTS todos (id INT PRIMARY KEY, title TEXT NOT NULL)",
          });
          return yield* HttpServerResponse.json({
            success: true,
            numberOfRecordsUpdated: result.numberOfRecordsUpdated ?? 0,
          });
        }

        // Bootstrap the IAM-auth database user for the Drizzle fixture:
        // `rds_iam` switches the user to token authentication, and the
        // grants let it read the shared `todos` table. Idempotent so the
        // suite can re-run against a standing deployment.
        if (request.method === "POST" && pathname === "/setup-iam-user") {
          yield* executeStatement({
            sql: "DO $$ BEGIN CREATE USER app_iam WITH LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
          });
          yield* executeStatement({ sql: "GRANT rds_iam TO app_iam" });
          yield* executeStatement({
            sql: "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_iam",
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "POST" && pathname === "/insert") {
          const body = (yield* request.json) as unknown as {
            id: number;
            title: string;
          };
          const result = yield* executeStatement({
            sql: "INSERT INTO todos (id, title) VALUES (:id, :title) ON CONFLICT (id) DO UPDATE SET title = :title",
            parameters: [
              { name: "id", value: { longValue: body.id } },
              { name: "title", value: { stringValue: body.title } },
            ],
          });
          return yield* HttpServerResponse.json({
            success: true,
            numberOfRecordsUpdated: result.numberOfRecordsUpdated ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/select") {
          const id = url.searchParams.get("id");
          if (!id) {
            return HttpServerResponse.text("Missing id", { status: 400 });
          }
          const result = yield* executeStatement({
            sql: "SELECT id, title FROM todos WHERE id = :id",
            parameters: [{ name: "id", value: { longValue: Number(id) } }],
          });
          return yield* HttpServerResponse.json({
            records: result.records ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/count") {
          const result = yield* executeStatement({
            sql: "SELECT count(*)::int FROM todos",
          });
          return yield* HttpServerResponse.json({
            records: result.records ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/batch-insert") {
          const body = (yield* request.json) as unknown as {
            rows: { id: number; title: string }[];
          };
          const result = yield* batchExecuteStatement({
            sql: "INSERT INTO todos (id, title) VALUES (:id, :title) ON CONFLICT (id) DO UPDATE SET title = :title",
            parameterSets: body.rows.map((row) => [
              { name: "id", value: { longValue: row.id } },
              { name: "title", value: { stringValue: row.title } },
            ]),
          });
          return yield* HttpServerResponse.json({
            updateResults: result.updateResults ?? [],
          });
        }

        // Begin → insert inside the transaction → commit.
        if (request.method === "POST" && pathname === "/tx-commit") {
          const body = (yield* request.json) as unknown as {
            id: number;
            title: string;
          };
          const tx = yield* beginTransaction();
          yield* executeStatement({
            sql: "INSERT INTO todos (id, title) VALUES (:id, :title)",
            parameters: [
              { name: "id", value: { longValue: body.id } },
              { name: "title", value: { stringValue: body.title } },
            ],
            transactionId: tx.transactionId,
          });
          const commit = yield* commitTransaction({
            transactionId: tx.transactionId!,
          });
          return yield* HttpServerResponse.json({
            transactionId: tx.transactionId,
            transactionStatus: commit.transactionStatus,
          });
        }

        // Begin → insert inside the transaction → rollback (row must vanish).
        if (request.method === "POST" && pathname === "/tx-rollback") {
          const body = (yield* request.json) as unknown as {
            id: number;
            title: string;
          };
          const tx = yield* beginTransaction();
          yield* executeStatement({
            sql: "INSERT INTO todos (id, title) VALUES (:id, :title)",
            parameters: [
              { name: "id", value: { longValue: body.id } },
              { name: "title", value: { stringValue: body.title } },
            ],
            transactionId: tx.transactionId,
          });
          const rollback = yield* rollbackTransaction({
            transactionId: tx.transactionId!,
          });
          return yield* HttpServerResponse.json({
            transactionId: tx.transactionId,
            transactionStatus: rollback.transactionStatus,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        RDSData.ExecuteStatementHttp,
        RDSData.BatchExecuteStatementHttp,
        RDSData.BeginTransactionHttp,
        RDSData.CommitTransactionHttp,
        RDSData.RollbackTransactionHttp,
        RDS.ConnectHttp,
      ),
    ),
  ),
);

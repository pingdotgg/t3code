import * as DocDB from "@/AWS/DocDB";
import type { SecurityGroupId } from "@/AWS/EC2/SecurityGroup.ts";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "slow-handler.ts");

/**
 * The gated test resolves the default VPC's subnets/security group at
 * runtime (a lookup this fixture module cannot perform) and passes them via
 * env before deploying. The fixture's init Effect runs in the same process,
 * so the values are visible here at deploy time.
 */
const subnetIds = () =>
  (process.env.DOCDB_TEST_SUBNET_IDS ?? "")
    .split(",")
    .filter((id): id is SubnetId => id.startsWith("subnet-"));
const securityGroupIds = () =>
  (process.env.DOCDB_TEST_SG_IDS ?? "")
    .split(",")
    .filter((id): id is SecurityGroupId => id.startsWith("sg-"));

// The mongodb driver's optional native/companion packages are `require`d in
// try/catch fallbacks — leave them external so the bundle builds and the
// driver's graceful degradation kicks in at runtime.
const MONGODB_OPTIONAL_DEPS = [
  "kerberos",
  "@mongodb-js/zstd",
  "@aws-sdk/credential-providers",
  "gcp-metadata",
  "snappy",
  "socks",
  "aws4",
  "mongodb-client-encryption",
];

export class DocDBSlowTestFunction extends Lambda.Function<Lambda.Function>()(
  "DocDBSlowTestFunction",
) {}

/**
 * Data-plane fixture: deploys a real DocumentDB cluster + instance
 * (~10-15 minutes, billed per instance-hour — gated behind AWS_TEST_SLOW)
 * and a VPC-attached Lambda bound with Connect + the mongo Effect client.
 */
export default DocDBSlowTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
    build: { external: MONGODB_OPTIONAL_DEPS },
  },
  Effect.gen(function* () {
    const subnetGroup = yield* DocDB.DBSubnetGroup("Subnets", {
      description: "alchemy docdb bindings test subnets",
      subnetIds: subnetIds(),
    });
    const cluster = yield* DocDB.DBCluster("Docs", {
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: securityGroupIds(),
      masterUsername: "alchemy",
      manageMasterUserPassword: true,
      backupRetentionPeriod: "1 day",
      deletionProtection: false,
      tags: { fixture: "docdb-bindings" },
    });
    yield* DocDB.DBInstance("Writer", {
      dbClusterIdentifier: cluster.dbClusterIdentifier,
      dbInstanceClass: "db.t3.medium",
      tags: { fixture: "docdb-bindings" },
    });

    // init — bind the managed master secret + attach the Lambda to the
    // cluster's VPC so it can open a MongoDB-protocol socket.
    const connect = yield* DocDB.Connect(cluster, {
      database: "alchemy_test",
      subnetIds: subnetIds(),
      securityGroupIds: securityGroupIds(),
    });
    const db = yield* DocDB.mongo(connect);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/info") {
          const info = yield* connect;
          const prefix = DocDB.connectEnvPrefix("Docs");
          const env = yield* Effect.sync(() => ({
            host: process.env[`${prefix}_HOST`],
            port: process.env[`${prefix}_PORT`],
          }));
          return yield* HttpServerResponse.json({
            host: info.host,
            port: info.port,
            database: info.database,
            username: info.username,
            tls: info.tls,
            hasPassword: info.password !== undefined,
            env,
          });
        }

        if (request.method === "GET" && pathname === "/ping") {
          const { use } = yield* db;
          const pong = yield* use((_db, client) =>
            client.db("admin").command({ ping: 1 }),
          );
          return yield* HttpServerResponse.json({ ok: pong.ok });
        }

        if (request.method === "GET" && pathname === "/crud") {
          const { use } = yield* db;
          const value = url.searchParams.get("value") ?? "roundtrip";
          const found = yield* use(async (db) => {
            const orders = db.collection("orders");
            await orders.insertOne({ marker: value, at: new Date() });
            return orders.findOne({ marker: value });
          });
          return yield* HttpServerResponse.json({
            marker: (found as { marker?: string } | null)?.marker,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(DocDB.ConnectHttp))),
);

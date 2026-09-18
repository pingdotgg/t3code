import * as AWS from "@/AWS";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Valkey from "iovalkey";
import * as net from "node:net";
import { getProvisionedNetwork } from "./ProvisionedFixture.ts";

export class ProvisionedCacheDataPlaneFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "ProvisionedCacheDataPlaneFunction",
) {}

const valkeyRoundtrip = (
  info: AWS.ElastiCache.ReplicationGroupConnectionInfo,
  value: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const client = new Valkey({
        host: info.host,
        port: info.port,
        ...(info.tls ? { tls: {} } : {}),
        connectTimeout: 10_000,
        maxRetriesPerRequest: 2,
        retryStrategy: (attempt) => (attempt > 2 ? null : 500),
      });
      try {
        await client.set("alchemy:provisioned:valkey", value);
        return await client.get("alchemy:provisioned:valkey");
      } finally {
        client.disconnect();
      }
    },
    catch: (cause) => new Error(`Valkey roundtrip failed: ${String(cause)}`),
  });

const memcachedRoundtrip = (
  endpoint: { address: string; port: number },
  value: string,
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(endpoint.port, endpoint.address);
        let response = "";
        const key = "alchemy:provisioned:memcached";
        const payload = `set ${key} 0 30 ${Buffer.byteLength(value)}\r\n${value}\r\nget ${key}\r\n`;
        const fail = (error: Error) => {
          socket.destroy();
          reject(error);
        };
        socket.setTimeout(10_000, () => fail(new Error("Memcached timed out")));
        socket.once("error", fail);
        socket.on("data", (chunk) => {
          response += chunk.toString();
          if (!response.endsWith("END\r\n")) return;
          socket.end();
          const match = response.match(/VALUE [^\r]+\r\n([^\r]+)\r\nEND\r\n$/);
          if (match?.[1] === undefined) {
            reject(new Error(`Unexpected Memcached response: ${response}`));
            return;
          }
          resolve(match[1]);
        });
        socket.once("connect", () => socket.write(payload));
      }),
    catch: (cause) => new Error(`Memcached roundtrip failed: ${String(cause)}`),
  });

const ProvisionedCacheDataPlaneLive = ProvisionedCacheDataPlaneFunction.make(
  Effect.succeed({
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(30),
    memorySize: 256,
  }),
  Effect.gen(function* () {
    const net = yield* getProvisionedNetwork;
    const lambdaSecurityGroup = yield* AWS.EC2.SecurityGroup(
      "LambdaSecurityGroup",
      {
        vpcId: net.vpcId,
        description: "Provisioned ElastiCache data-plane test Lambda",
      },
    );
    yield* AWS.EC2.SecurityGroupRule("ValkeyIngress", {
      groupId: net.securityGroupId,
      type: "ingress",
      ipProtocol: "tcp",
      fromPort: 6379,
      toPort: 6379,
      referencedGroupId: lambdaSecurityGroup.groupId,
    });
    yield* AWS.EC2.SecurityGroupRule("MemcachedIngress", {
      groupId: net.securityGroupId,
      type: "ingress",
      ipProtocol: "tcp",
      fromPort: 11211,
      toPort: 11211,
      referencedGroupId: lambdaSecurityGroup.groupId,
    });
    const valkey = yield* AWS.ElastiCache.ReplicationGroup("Valkey", {
      description: "Alchemy provisioned Valkey data-plane test",
      engine: "valkey",
      nodeType: "cache.t4g.micro",
      subnetGroupName: net.subnetGroupName,
      securityGroupIds: [net.securityGroupId],
      replicasPerNodeGroup: 0,
      transitEncryptionEnabled: false,
    });
    const memcached = yield* AWS.ElastiCache.CacheCluster("Memcached", {
      nodeType: "cache.t4g.micro",
      subnetGroupName: net.subnetGroupName,
      securityGroupIds: [net.securityGroupId],
      numCacheNodes: 1,
    });
    const valkeyConnection = yield* AWS.ElastiCache.ConnectReplicationGroup(
      valkey,
      {
        subnetIds: net.privateSubnetIds,
        securityGroupIds: [lambdaSecurityGroup.groupId],
      },
    );
    const memcachedConnection = yield* AWS.ElastiCache.ConnectCacheCluster(
      memcached,
      {
        subnetIds: net.privateSubnetIds,
        securityGroupIds: [lambdaSecurityGroup.groupId],
      },
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const value = url.searchParams.get("value") ?? "hello-provisioned";
        if (request.method === "GET" && url.pathname === "/connection") {
          const [valkey, memcached] = yield* Effect.all([
            valkeyConnection,
            memcachedConnection,
          ]);
          return yield* HttpServerResponse.json({ valkey, memcached });
        }
        if (request.method === "GET" && url.pathname === "/valkey") {
          const info = yield* valkeyConnection;
          const read = yield* valkeyRoundtrip(info, value);
          return yield* HttpServerResponse.json({ value: read });
        }
        if (request.method === "GET" && url.pathname === "/memcached") {
          const info = yield* memcachedConnection;
          const endpoint = info.endpoints[0];
          if (endpoint === undefined) {
            return yield* Effect.fail(
              new Error("Memcached endpoint is unavailable"),
            );
          }
          const read = yield* memcachedRoundtrip(endpoint, value);
          return yield* HttpServerResponse.json({ value: read });
        }
        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.ElastiCache.ConnectReplicationGroupHttp,
        AWS.ElastiCache.ConnectCacheClusterHttp,
      ),
    ),
  ),
);

export default ProvisionedCacheDataPlaneLive;

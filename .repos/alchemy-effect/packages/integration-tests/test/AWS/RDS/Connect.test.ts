import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import RdsConnectFunctionLive, { RdsConnectFunction } from "./fixtures/connect-handler.ts";
import { RdsConnectInfra } from "./fixtures/connect-infra.ts";

const { test } = Test.make({ providers: AWS.providers() });

class NotReady extends Data.TaggedError("NotReady")<{
  readonly message: string;
}> {}

// A fresh function URL (DNS, IAM propagation, VPC ENI attachment) and the
// first TLS handshake to a just-available instance take a while to settle.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.flatMap(response.text, (body) =>
            Effect.fail(
              new NotReady({
                message: `${request.method} ${request.url} -> ${response.status}: ${body}`,
              }),
            ),
          ),
    ),
    Effect.tapError((error) => Effect.logWarning(error.message)),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
  );

// Deploy (postgres db.t3.micro + VPC Lambda) measured ~12 minutes; destroy
// waits up to ~25 minutes for Lambda to release its VPC ENIs.
test.provider.skipIf(!!process.env.FAST)(
  "connects to a DBInstance with its managed master secret and IAM auth",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const region = yield* yield* Region;
      const { functionUrl, dbInstanceIdentifier, endpointAddress } = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, endpointSecurityGroup, instance } = yield* RdsConnectInfra;
          // The Lambda sits in isolated subnets; it reaches Secrets Manager
          // through an interface endpoint.
          yield* AWS.EC2.VpcEndpoint("ConnectSecretsManagerEndpoint", {
            vpcId: network.vpcId,
            serviceName: `com.amazonaws.${region}.secretsmanager`,
            vpcEndpointType: "Interface",
            subnetIds: network.privateSubnetIds,
            securityGroupIds: [endpointSecurityGroup.groupId],
            privateDnsEnabled: true,
          });
          const fn = yield* RdsConnectFunction;
          return {
            functionUrl: fn.functionUrl,
            dbInstanceIdentifier: instance.dbInstanceIdentifier,
            endpointAddress: instance.endpointAddress,
          };
        }).pipe(Effect.provide(RdsConnectFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      // Managed secret: host/port from the instance, credentials from the
      // RDS-managed master user secret.
      const info = (yield* send(HttpClientRequest.get(`${baseUrl}/connect-info`))) as {
        host: string;
        port: number;
        database?: string;
        username?: string;
        hasPassword: boolean;
        ssl: boolean;
      };
      expect(info).toEqual({
        host: endpointAddress,
        port: 5432,
        database: "postgres",
        username: "alchemy",
        hasPassword: true,
        ssl: true,
      });

      // Socket round-trip as the master user; bootstraps the IAM user.
      const master = (yield* send(HttpClientRequest.post(`${baseUrl}/setup-iam-user`))) as {
        rows: { user: string }[];
      };
      expect(master.rows).toEqual([{ user: "alchemy" }]);

      // Socket round-trip authenticated with a presigned IAM token, which
      // only works when `rds-db:connect` targets the instance's DbiResourceId.
      const iam = (yield* send(HttpClientRequest.get(`${baseUrl}/iam-user`))) as {
        rows: { user: string }[];
      };
      expect(iam.rows).toEqual([{ user: "app_iam" }]);

      yield* stack.destroy();

      const gone = yield* rds
        .describeDBInstances({ DBInstanceIdentifier: dbInstanceIdentifier })
        .pipe(
          Effect.as(false),
          Effect.catchTag("DBInstanceNotFoundFault", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
            until: (absent) => absent,
          }),
        );
      expect(gone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:lambda", "provider:aws:rds", "live"],
    timeout: 2_700_000,
  },
);

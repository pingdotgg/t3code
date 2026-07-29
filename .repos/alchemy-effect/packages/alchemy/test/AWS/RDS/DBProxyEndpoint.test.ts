import * as AWS from "@/AWS";
import { DBProxyEndpoint } from "@/AWS/RDS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Default read-only path: resolve the provider via the typed
// `Provider.findProvider(DBProxyEndpoint)` and call `list()` without deploying.
// A DB proxy + endpoint needs a VPC/subnets/IAM role and takes several minutes
// to provision (beyond the 240s budget, and the shared account hits VPC-limit /
// no-default-VPC issues), so the deploy-backed assertion is gated below. This
// path still exercises the full proxy enumeration + per-proxy endpoint
// hydration code and asserts a well-typed `Attributes[]` (likely empty).
test.provider("list returns well-typed DBProxyEndpoint attributes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBProxyEndpoint);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const endpoint of all) {
      expect(typeof endpoint.dbProxyEndpointName).toBe("string");
      expect(typeof endpoint.dbProxyEndpointArn).toBe("string");
      expect(Array.isArray(endpoint.vpcSubnetIds)).toBe(true);
      expect(Array.isArray(endpoint.vpcSecurityGroupIds)).toBe(true);
      expect(typeof endpoint.tags).toBe("object");
    }
  }),
);

// Deploy-backed list test. Gated behind AWS_TEST_RDS_DBPROXY=1 because a
// DBProxy + endpoint needs a VPC/subnets/IAM role and takes a few minutes to
// create — beyond the 240s budget, and the shared testing account hits VPC
// limits / no-default-VPC. Provide DBPROXY_ROLE_ARN / DBPROXY_SUBNET_IDS /
// DBPROXY_SECRET_ARN when running on an entitled account.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBPROXY)(
  "list enumerates the deployed DB proxy endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = (process.env.DBPROXY_SUBNET_IDS ?? "").split(",");
      const endpoint = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* AWS.RDS.DBProxy("ListEndpointProxy", {
            engineFamily: "POSTGRESQL",
            roleArn: process.env.DBPROXY_ROLE_ARN!,
            vpcSubnetIds: subnetIds,
            auth: [
              {
                AuthScheme: "SECRETS",
                SecretArn: process.env.DBPROXY_SECRET_ARN!,
                IAMAuth: "DISABLED",
              },
            ],
          });
          return yield* DBProxyEndpoint("ListEndpoint", {
            dbProxyName: proxy.dbProxyName,
            vpcSubnetIds: subnetIds,
            targetRole: "READ_ONLY",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBProxyEndpoint);
      const all = yield* provider.list();

      expect(
        all.some((e) => e.dbProxyEndpointName === endpoint.dbProxyEndpointName),
      ).toBe(true);

      yield* stack.destroy();
    }),
);

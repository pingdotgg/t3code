import * as AWS from "@/AWS";
import { DBProxy, DBProxyTargetGroup } from "@/AWS/RDS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Default read-only path: resolve the provider via the typed
// `Provider.findProvider(DBProxyTargetGroup)` and call `list()` without
// deploying. Target groups are proxy-scoped and a DB proxy requires a
// VPC/subnets/IAM role and takes several minutes to provision (beyond the 240s
// budget; the shared testing account also hits VPC limits / no-default-VPC), so
// the deploy-backed assertion is gated below. This path still exercises the
// full proxy fan-out + target-group enumeration + target hydration code and
// asserts a well-typed `Attributes[]` (likely empty on an account with no
// proxies).
test.provider("list returns well-typed DBProxyTargetGroup attributes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBProxyTargetGroup);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const group of all) {
      expect(typeof group.dbProxyName).toBe("string");
      expect(typeof group.targetGroupName).toBe("string");
      expect(Array.isArray(group.dbClusterIdentifiers)).toBe(true);
      expect(Array.isArray(group.dbInstanceIdentifiers)).toBe(true);
    }
  }),
);

// Deploy-backed list test. Gated behind AWS_TEST_RDS_DBPROXY=1 because a
// DBProxy (which owns the target group) needs a VPC/subnets/IAM role and takes
// a few minutes to create — beyond the 240s budget, and the shared testing
// account hits VPC limits / no-default-VPC. Provide DBPROXY_ROLE_ARN /
// DBPROXY_SUBNET_IDS / DBPROXY_SECRET_ARN when running on an entitled account.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBPROXY)(
  "list enumerates the deployed DB proxy target group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = (process.env.DBPROXY_SUBNET_IDS ?? "").split(",");
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* DBProxy("TGListProxy", {
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
          return yield* DBProxyTargetGroup("TGListGroup", {
            dbProxyName: proxy.dbProxyName,
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBProxyTargetGroup);
      const all = yield* provider.list();

      expect(
        all.some(
          (g) =>
            g.dbProxyName === deployed.dbProxyName &&
            g.targetGroupName === deployed.targetGroupName,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
);

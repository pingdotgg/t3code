import * as AWS from "@/AWS";
import { DBProxy } from "@/AWS/RDS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Default read-only path: resolve the provider via the typed
// `Provider.findProvider(DBProxy)` and call `list()` without deploying. A
// DB proxy requires a VPC/subnets/IAM role and takes several minutes to
// provision (beyond the 240s budget, and the shared account has VPC-limit /
// no-default-VPC issues), so the deploy-backed assertion is gated below. This
// path still exercises the full enumeration + tag-hydration code and asserts a
// well-typed `Attributes[]`.
test.provider("list returns well-typed DBProxy attributes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBProxy);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const proxy of all) {
      expect(typeof proxy.dbProxyName).toBe("string");
      expect(typeof proxy.dbProxyArn).toBe("string");
      expect(Array.isArray(proxy.vpcSubnetIds)).toBe(true);
      expect(Array.isArray(proxy.vpcSecurityGroupIds)).toBe(true);
      expect(typeof proxy.tags).toBe("object");
    }
  }),
);

// Deploy-backed list test. Gated behind AWS_TEST_RDS_DBPROXY=1 because a
// DBProxy needs a VPC/subnets/IAM role and takes a few minutes to create —
// beyond the 240s budget, and the shared testing account hits VPC limits /
// no-default-VPC. Provide DBPROXY_ROLE_ARN / DBPROXY_SUBNET_IDS /
// DBPROXY_SECRET_ARN when running on an entitled account.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBPROXY)(
  "list enumerates the deployed DB proxy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = (process.env.DBPROXY_SUBNET_IDS ?? "").split(",");
      const proxy = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DBProxy("ListDBProxy", {
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
        }),
      );

      const provider = yield* Provider.findProvider(DBProxy);
      const all = yield* provider.list();

      expect(all.some((p) => p.dbProxyName === proxy.dbProxyName)).toBe(true);

      yield* stack.destroy();
    }),
);

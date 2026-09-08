import * as AWS from "alchemy/AWS";
import * as Lambda from "alchemy/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { AuroraDataApi } from "../../../src/AuroraDataApi.ts";
import { BetterAuth } from "../../../src/index.ts";

const main = path.resolve(import.meta.dirname, "aurora-handler.ts");

/**
 * Aurora Serverless v2 with the Data API (enabled by default). The cluster
 * needs a VPC, but the Lambda does NOT join it — all access is HTTPS via
 * the Data API bindings.
 */
export const Db = Effect.gen(function* () {
  const network = yield* AWS.EC2.Network("AuroraAuthNetwork", {
    cidrBlock: "10.42.0.0/16",
    availabilityZones: 2,
  });
  const securityGroup = yield* AWS.EC2.SecurityGroup(
    "AuroraAuthDbSecurityGroup",
    {
      vpcId: network.vpcId,
      description: "Better Auth Aurora Data API test cluster",
    },
  );
  return yield* AWS.RDS.Aurora("AuroraAuthDb", {
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [securityGroup.groupId],
  });
});

// The layer takes the Aurora composite directly — cluster + secret +
// writer dependency all wired from one value.
const AuthDatabase = AuroraDataApi(Db, { database: "postgres" });

export class AuroraAuthFunction extends Lambda.Function<Lambda.Function>()(
  "BetterAuthAuroraFunction",
) {}

export default AuroraAuthFunction.make(
  {
    main,
    url: true,
    memorySize: 512,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/auth",
      emailAndPassword: { enabled: true },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.url, "http://lambda").pathname;
        if (pathname.startsWith("/auth")) {
          return yield* auth.fetch;
        }
        if (pathname.startsWith("/me")) {
          const session = yield* auth
            .getSession()
            .pipe(
              Effect.catchTag("BetterAuthApiError", () => Effect.succeed(null)),
            );
          return yield* HttpServerResponse.json({
            email: session?.user.email ?? null,
          });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(AuthDatabase)),
);

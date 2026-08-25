import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Lambda from "@/AWS/Lambda";
import * as SecurityLake from "@/AWS/SecurityLake";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class SecurityLakeBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "SecurityLakeBindingsFunction",
) {}

export default SecurityLakeBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;

    const metastoreRole = yield* Role("BindingsMetastoreRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonSecurityLakeMetastoreManager",
      ],
    });

    const lake = yield* SecurityLake.DataLake("BindingsLake", {
      configurations: [{ region }],
      metaStoreManagerRoleArn: metastoreRole.roleArn,
    });

    const listExceptions = yield* SecurityLake.ListDataLakeExceptions(lake);
    const getSources = yield* SecurityLake.GetDataLakeSources(lake);

    const bound = { listExceptions, getSources };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/exceptions") {
          // An IAM gap would surface AccessDeniedException (a 500); a
          // successful (possibly empty) list proves the grant end-to-end.
          const response = yield* listExceptions();
          return yield* HttpServerResponse.json({
            count: (response.exceptions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/sources") {
          const response = yield* getSources();
          return yield* HttpServerResponse.json({
            dataLakeArn: response.dataLakeArn,
            count: (response.dataLakeSources ?? []).length,
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
        SecurityLake.ListDataLakeExceptionsHttp,
        SecurityLake.GetDataLakeSourcesHttp,
      ),
    ),
  ),
);

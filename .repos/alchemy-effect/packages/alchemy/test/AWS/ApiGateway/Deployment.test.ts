import * as AWS from "@/AWS";
import { deleteRestApiAndWait } from "@/AWS/ApiGateway/common.ts";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

// `deleteRestApi` is governed by a hard account-wide throttle (~1 request per
// 30s). During a fleet-wide test wave the teardown of this suite can race
// other suites' REST API deletes; if the vitest process is killed before the
// provider's throttle retry wins, the REST API (and its ~21 auto-created
// GatewayResponses) is stranded. The physical name is deterministic
// (`{stack}-{logicalId}-{stage}-{suffix}`), so reap out-of-band by the
// `-{logicalId}-test-` marker: run as a pre-clean before deploy (covers
// strays from a previous killed run even when the state store was wiped) and
// as an `Effect.ensuring` finalizer (covers mid-test failures).
const reapRestApis = (logicalId: string) =>
  ag.getRestApis.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) =>
        (page.items ?? []).filter(
          (api): api is ag.RestApi & { id: string } =>
            api.id != null &&
            (api.name?.includes(`-${logicalId}-test-`) ?? false),
        ),
      ),
    ),
    Effect.flatMap(Effect.forEach((api) => deleteRestApiAndWait(api.id))),
    Effect.asVoid,
    // Finalizer contract: the error channel must be `never`. Any unexpected
    // error here is a genuinely stuck delete and should surface as a defect.
    Effect.orDie,
  );

test.provider.skipIf(!!process.env.FAST)(
  "create and delete deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* reapRestApis("AgDepApi");

      const { api, deployment } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgDepApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgDepMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgDep", {
            restApi: api,
            description: "alchemy-test-deployment",
          });
          return { api, deployment };
        }),
      );

      expect(deployment.deploymentId).toBeDefined();

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }).pipe(Effect.ensuring(reapRestApis("AgDepApi"))),
);

test.provider.skipIf(!!process.env.FAST)(
  "deployment trigger change creates new deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* reapRestApis("AgTrigApi");

      const { api, d1 } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgTrigApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgTrigMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgTrigDep", {
            restApi: api,
            description: "v1",
            triggers: { t: "a" },
          });
          return { api, d1: deployment };
        }),
      );

      const { d2 } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgTrigApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgTrigMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgTrigDep", {
            restApi: api,
            description: "v1",
            triggers: { t: "b" },
          });
          return { d2: deployment };
        }),
      );

      expect(d2.deploymentId).not.toEqual(d1.deploymentId);

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }).pipe(Effect.ensuring(reapRestApis("AgTrigApi"))),
);

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* reapRestApis("AgListApi");

      const { api, deployment } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgListApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgListMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgListDep", {
            restApi: api,
            description: "alchemy-test-list-deployment",
          });
          return { api, deployment };
        }),
      );

      const provider = yield* Provider.findProvider(
        AWS.ApiGateway.DeploymentResource,
      );
      const all = yield* provider.list();

      expect(all.some((d) => d.deploymentId === deployment.deploymentId)).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertRestApiDeleted(api.restApiId);
    }).pipe(Effect.ensuring(reapRestApis("AgListApi"))),
);

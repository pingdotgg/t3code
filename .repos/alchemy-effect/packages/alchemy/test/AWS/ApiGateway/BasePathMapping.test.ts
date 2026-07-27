import * as AWS from "@/AWS";
import { BasePathMapping } from "@/AWS/ApiGateway/BasePathMapping";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertRestApiDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

// A custom DomainName (the parent of a BasePathMapping) requires a validated
// ACM certificate + DNS, which cannot be provisioned in CI — that is why
// DomainName.test.ts is skipped. The full deploy+assert flow is therefore
// gated behind env vars pointing at a pre-provisioned domain/cert. The
// ungated test below still exercises `list()` live (it enumerates every
// domain name and its mappings) to prove the operation works end-to-end.

const testDomainName = process.env.AWS_TEST_APIGATEWAY_DOMAIN;
const testCertificateArn = process.env.AWS_TEST_ACM_CERTIFICATE_ARN;

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates base path mappings across domains",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(BasePathMapping);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const m of all) {
        expect(typeof m.domainName).toBe("string");
        expect(typeof m.basePath).toBe("string");
        expect(typeof m.restApiId).toBe("string");
      }
    }),
);

test.provider.skipIf(
  !!process.env.FAST || !testDomainName || !testCertificateArn,
)(
  "list includes a deployed base path mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("BpmListApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });

          yield* AWS.ApiGateway.Method("BpmListRootGet", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });

          const deployment = yield* AWS.ApiGateway.Deployment("BpmListDep", {
            restApi: api,
            description: "list test",
          });

          const stage = yield* AWS.ApiGateway.Stage("BpmListStage", {
            restApi: api,
            stageName: "test",
            deploymentId: deployment.deploymentId,
          });

          const domain = yield* AWS.ApiGateway.DomainName("BpmListDomain", {
            domainName: testDomainName!,
            regionalCertificateArn: testCertificateArn!,
            endpointConfiguration: { types: ["REGIONAL"] },
            securityPolicy: "TLS_1_2",
          });

          return yield* BasePathMapping("BpmListMapping", {
            domainName: domain.domainName,
            restApiId: api.restApiId,
            stage: stage.stageName,
          });
        }),
      );

      const provider = yield* Provider.findProvider(BasePathMapping);
      const all = yield* provider.list();

      expect(
        all.some(
          (m) =>
            m.domainName === deployed.domainName &&
            m.basePath === deployed.basePath &&
            m.restApiId === deployed.restApiId,
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertRestApiDeleted(deployed.restApiId);
    }),
  { timeout: 600_000 },
);

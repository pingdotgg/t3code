import * as AWS from "@/AWS";
import { DomainName } from "@/AWS/ApiGatewayV2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated live probe: `list()` enumerates every v2 custom domain in the
// account/region and maps each item to the `read` Attributes shape. A
// custom domain cannot be provisioned in CI (it needs a validated ACM
// certificate for a domain we own — see the gated test below), but this
// still verifies pagination + mapping against the live API.
test.provider.skipIf(!!process.env.FAST)(
  "list returns the account/region domain names",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(DomainName);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const domain of all) {
        expect(typeof domain.domainName).toBe("string");
        expect(domain.tags).toBeDefined();
      }
    }),
);

// Full lifecycle. SKIPPED by default: an API Gateway v2 custom domain
// requires a validated REGIONAL ACM certificate for a domain you own (ACM
// issuance needs DNS/email validation, which CI cannot complete). Set
// AWS_TEST_APIGATEWAY_DOMAIN_NAME (a domain you own) and
// AWS_TEST_APIGATEWAY_CERT_ARN (a validated regional ACM cert in this
// region) to run it on an entitled account unchanged — the same env vars
// the v1 DomainName test uses.
const domainName = process.env.AWS_TEST_APIGATEWAY_DOMAIN_NAME;
const certificateArn = process.env.AWS_TEST_APIGATEWAY_CERT_ARN;

test.provider.skipIf(!!process.env.FAST || !domainName || !certificateArn)(
  "create domain name, map an API, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* AWS.ApiGatewayV2.DomainName("V2Domain", {
            domainName: domainName!,
            domainNameConfigurations: [
              {
                CertificateArn: certificateArn!,
                EndpointType: "REGIONAL",
                SecurityPolicy: "TLS_1_2",
              },
            ],
          });

          const api = yield* AWS.ApiGatewayV2.Api("V2DomainApi", {});
          const stage = yield* AWS.ApiGatewayV2.Stage("V2DomainStage", {
            api,
            autoDeploy: true,
          });

          const mapping = yield* AWS.ApiGatewayV2.ApiMapping("V2Mapping", {
            api,
            domainName: domain.domainName,
            stage: stage.stageName,
            apiMappingKey: "v2test",
          });

          return {
            domainName: domain.domainName,
            apiId: api.apiId,
            apiMappingId: mapping.apiMappingId,
          };
        }),
      );

      const remoteDomain = yield* agw2.getDomainName({
        DomainName: out.domainName,
      });
      expect(remoteDomain.DomainName).toBe(domainName);

      const remoteMapping = yield* agw2.getApiMapping({
        DomainName: out.domainName,
        ApiMappingId: out.apiMappingId,
      });
      expect(remoteMapping.ApiId).toBe(out.apiId);
      expect(remoteMapping.ApiMappingKey).toBe("v2test");

      yield* stack.destroy();

      const gone = yield* agw2
        .getApiMapping({
          DomainName: out.domainName,
          ApiMappingId: out.apiMappingId,
        })
        .pipe(
          Effect.map(() => "still-exists" as const),
          Effect.catchTag("NotFoundException", () =>
            Effect.succeed("deleted" as const),
          ),
        );
      expect(gone).toBe("deleted");
    }),
  { timeout: 240_000 },
);

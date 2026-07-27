import * as AWS from "@/AWS";
import { DomainName } from "@/AWS/ApiGateway";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertDomainNameDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated live probe: `list()` enumerates every custom domain in the
// account/region. It paginates `getDomainNames` exhaustively and maps each item
// to the same Attributes shape `read` returns. We don't deploy here because an
// API Gateway custom domain can't be provisioned in CI (see the gated test
// below) — but this still verifies the pagination + mapping against the live
// API and asserts every returned row is well-formed.
test.provider.skipIf(!!process.env.FAST)(
  "list returns the account/region domain names",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(DomainName);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const d of all) {
        expect(typeof d.domainName).toBe("string");
        expect(d.tags).toBeDefined();
      }
    }),
);

// Full deploy-then-list assertion. SKIPPED by default because an API Gateway
// custom domain requires a certificate that AWS accepts:
//   - EDGE + uploaded cert  -> CloudFront rejects a self-signed cert:
//       BadRequestException "The certificate that is attached to your
//       distribution was not issued by a trusted Certificate Authority."
//   - REGIONAL              -> requires an ACM `regionalCertificateArn` for a
//       domain you own (ACM issuance needs DNS/email validation).
// Set AWS_TEST_APIGATEWAY_DOMAIN_NAME (a domain you own) and
// AWS_TEST_APIGATEWAY_CERT_ARN (a validated regional ACM cert in this region)
// to run it on an entitled account unchanged.
const domainName = process.env.AWS_TEST_APIGATEWAY_DOMAIN_NAME;
const certificateArn = process.env.AWS_TEST_APIGATEWAY_CERT_ARN;

test.provider.skipIf(!!process.env.FAST || !domainName || !certificateArn)(
  "list enumerates the deployed domain name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domain = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DomainName("ListDomain", {
            domainName: domainName!,
            regionalCertificateArn: certificateArn!,
            endpointConfiguration: { types: ["REGIONAL"] },
            securityPolicy: "TLS_1_2",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DomainName);
      const all = yield* provider.list();

      expect(all.some((d) => d.domainName === domain.domainName)).toBe(true);

      yield* stack.destroy();
      yield* assertDomainNameDeleted(domain.domainName);
    }),
);

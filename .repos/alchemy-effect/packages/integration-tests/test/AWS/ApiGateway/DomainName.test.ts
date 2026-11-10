import * as AWS from "@alchemy.run/aws";
import { DomainName } from "@alchemy.run/aws/ApiGateway";
import { expect } from "@alchemy.run/test";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { driftOf, repairDrift, waitForDrift } from "../drift.ts";
import { assertDomainNameDeleted } from "./assertions.ts";
import * as Test from "./Test.ts";

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
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
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

      // #2688: `read` must observe the TLS policy and certificates, or an
      // out-of-band change reads as `unchanged`.
      expect((yield* driftOf(stack, "ListDomain"))?.action).toBe("unchanged");
      yield* ag.updateDomainName({
        domainName: domain.domainName,
        patchOperations: [{ op: "replace", path: "/securityPolicy", value: "TLS_1_0" }],
      });
      expect(
        (yield* waitForDrift(stack, "ListDomain", "drifted"))?.attr?.configuration?.securityPolicy,
      ).toBe("TLS_1_0");
      yield* repairDrift(stack);
      expect((yield* waitForDrift(stack, "ListDomain", "unchanged"))?.action).toBe("unchanged");
      const restored = yield* ag.getDomainName({ domainName: domain.domainName });
      expect(restored.securityPolicy).toBe("TLS_1_2");

      yield* stack.destroy();
      yield* assertDomainNameDeleted(domain.domainName);
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);

import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as appsync from "@distilled.cloud/aws/appsync";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const SCHEMA = `
type Query {
  hello: String
}
schema { query: Query }
`;

// AppSync custom domains require an ACM certificate in us-east-1
// (CloudFront-backed). The full lifecycle is gated on a standing cert;
// the ungated probe below pins the typed rejection forever.
const domainName = process.env.AWS_TEST_APPSYNC_DOMAIN_NAME;
const certificateArn = process.env.AWS_TEST_APPSYNC_DOMAIN_CERT_ARN;

test.provider(
  "createDomainName rejects a certificate that does not exist (typed probe)",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        appsync.createDomainName({
          domainName: "alchemy-appsync-probe.example.com",
          certificateArn:
            "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        // Cross-account/nonexistent cert surfaces as the typed
        // BadRequestException (or AccessDenied depending on validation
        // order) — never an untyped catch-all.
        expect(["BadRequestException", "AccessDeniedException"]).toContain(
          result.failure._tag,
        );
      }
    }),
  { timeout: 60_000 },
);

test.provider.skipIf(!domainName || !certificateArn)(
  "custom domain + api association lifecycle (gated)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.AppSync.GraphqlApi("DomainApi", {
            schema: SCHEMA,
          });
          const domain = yield* AWS.AppSync.DomainName("Domain", {
            domainName: domainName!,
            certificateArn: certificateArn!,
            description: "alchemy test domain",
          });
          yield* AWS.AppSync.ApiAssociation("Assoc", { domain, api });
          return {
            apiId: api.apiId,
            domainName: domain.domainName,
            appsyncDomainName: domain.appsyncDomainName,
          };
        }),
      );

      expect(out.appsyncDomainName).toContain("cloudfront");

      const remote = yield* appsync.getDomainName({
        domainName: out.domainName,
      });
      expect(remote.domainNameConfig?.certificateArn).toBe(certificateArn);

      const association = yield* appsync.getApiAssociation({
        domainName: out.domainName,
      });
      expect(association.apiAssociation?.apiId).toBe(out.apiId);

      yield* stack.destroy();

      const gone = yield* appsync
        .getDomainName({ domainName: out.domainName })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 240_000 },
);

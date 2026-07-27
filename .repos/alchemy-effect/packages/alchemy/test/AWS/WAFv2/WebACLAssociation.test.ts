import * as AWS from "@/AWS";
import { GraphqlApi } from "@/AWS/AppSync";
import { WebACL, WebACLAssociation } from "@/AWS/WAFv2";
import * as Test from "@/Test/Alchemy";
import * as sts from "@distilled.cloud/aws/sts";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class WebACLStillExists extends Data.TaggedError("WebACLStillExists")<{
  readonly name: string;
}> {}

class AssociationPending extends Data.TaggedError("AssociationPending")<{
  readonly resourceArn: string;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
}> {}

const assertWebAclDeleted = (name: string, id: string) =>
  wafv2.getWebACL({ Name: name, Scope: "REGIONAL", Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new WebACLStillExists({ name }))),
    Effect.catchTag("WAFNonexistentItemException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "WebACLStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Association reads are eventually consistent — poll until the observed web
// ACL matches the expectation (bounded).
const assertAssociated = (resourceArn: string, expected: string | undefined) =>
  wafv2.getWebACLForResource({ ResourceArn: resourceArn }).pipe(
    Effect.flatMap((response) =>
      response.WebACL?.ARN === expected
        ? Effect.void
        : Effect.fail(
            new AssociationPending({
              resourceArn,
              expected,
              actual: response.WebACL?.ARN,
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "AssociationPending",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

// Ungated probe: associateWebACL with well-formed but nonexistent ARNs
// returns the typed WAFNonexistentItemException — proves the distilled
// wiring and the typed error union at near-zero cost, without creating
// any resources.
test.provider(
  "associateWebACL surfaces typed WAFNonexistentItemException",
  () =>
    Effect.gen(function* () {
      const identity = yield* sts.getCallerIdentity({});
      const account = identity.Account;
      const result = yield* Effect.result(
        wafv2.associateWebACL({
          WebACLArn: `arn:aws:wafv2:us-west-2:${account}:regional/webacl/alchemy-probe-nonexistent/00000000-0000-0000-0000-000000000000`,
          ResourceArn: `arn:aws:appsync:us-west-2:${account}:apis/alchemyprobenonexistent`,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("WAFNonexistentItemException");
      }
    }),
);

// Live lifecycle is gated: associating a FRESHLY CREATED web ACL (or
// protected resource) intermittently fails with
//   WAFUnavailableEntityException: AWS WAF couldn’t retrieve the resource
//   that you requested. Retry your request.
// for well over 150s (~50% of back-to-back runs; observed with both
// Cognito user pool and AppSync API targets; terraform-provider-aws
// retries this for 5 minutes — see hashicorp/terraform-provider-aws#24386).
// The provider retries the tag on a ~150s budget which covers routine
// propagation; the deterministic suite can't absorb the multi-minute tail.
test.provider.skipIf(!process.env.AWS_TEST_WAF_ASSOCIATION)(
  "associate a web ACL with an AppSync API, re-point, disassociate",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      // create API + ACL + association in one deploy
      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GraphqlApi("WafProtectedApi", {});
          const acl = yield* WebACL("PoolAclA", {});
          yield* WebACLAssociation("PoolAssociation", {
            webAclArn: acl.webAclArn,
            resourceArn: api.apiArn,
          });
          return {
            apiArn: api.apiArn,
            aclName: acl.webAclName,
            aclId: acl.webAclId,
            aclArn: acl.webAclArn,
          };
        }),
      );

      // out-of-band verification via getWebACLForResource
      yield* assertAssociated(outputs.apiArn, outputs.aclArn);

      // re-point the association at a second web ACL in place (keep the
      // first ACL deployed — never drop a dependency in the same step)
      const repointed = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GraphqlApi("WafProtectedApi", {});
          yield* WebACL("PoolAclA", {});
          const aclB = yield* WebACL("PoolAclB", {});
          yield* WebACLAssociation("PoolAssociation", {
            webAclArn: aclB.webAclArn,
            resourceArn: api.apiArn,
          });
          return {
            aclBName: aclB.webAclName,
            aclBId: aclB.webAclId,
            aclBArn: aclB.webAclArn,
          };
        }),
      );

      expect(repointed.aclBArn).not.toBe(outputs.aclArn);
      yield* assertAssociated(outputs.apiArn, repointed.aclBArn);

      // destroy everything; deletion order proves the association was
      // removed before its web ACL (deleteWebACL fails while associated)
      yield* stack.destroy();
      yield* assertWebAclDeleted(outputs.aclName, outputs.aclId);
      yield* assertWebAclDeleted(repointed.aclBName, repointed.aclBId);
    }),
  // First associate can wait up to ~150s for the fresh user pool to
  // propagate to WAF (retryUnavailableEntityLong).
  { timeout: 240_000 },
);

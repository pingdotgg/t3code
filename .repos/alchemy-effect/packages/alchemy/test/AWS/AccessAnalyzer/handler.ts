import * as AccessAnalyzer from "@/AWS/AccessAnalyzer";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// The fixture analyzer is ACCOUNT_UNUSED_ACCESS (not ACCOUNT) on purpose:
// AWS allows only ONE external-access account analyzer per Region, and
// Analyzer.test.ts exercises that singleton's lifecycle. Using the
// unused-access type keeps the two suites quota-independent.
export const FIXTURE_ANALYZER_NAME = "alchemy-test-bindings-unused-access";
export const FIXTURE_RULE_NAME = "alchemy-test-bindings-rule";

// Deterministic sample policies (checked-in constants, never generated at
// test time).
const IDENTITY_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: "arn:aws:s3:::alchemy-test-bucket/*",
    },
  ],
});

// Superset of IDENTITY_POLICY — used as the "existing" policy so the new
// policy (IDENTITY_POLICY) grants no new access.
const WIDER_IDENTITY_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: "arn:aws:s3:::alchemy-test-bucket/*",
    },
  ],
});

// Non-public bucket policy: access limited to a single account principal.
const PRIVATE_BUCKET_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::111111111111:root" },
      Action: "s3:GetObject",
      Resource: "arn:aws:s3:::alchemy-test-bucket/*",
    },
  ],
});

export class AccessAnalyzerTestFunction extends Lambda.Function<Lambda.Function>()(
  "AccessAnalyzerTestFunction",
) {}

export default AccessAnalyzerTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const analyzer = yield* AccessAnalyzer.Analyzer("BindingsAnalyzer", {
      analyzerName: FIXTURE_ANALYZER_NAME,
      type: "ACCOUNT_UNUSED_ACCESS",
    });
    yield* AccessAnalyzer.ArchiveRule("BindingsArchiveRule", {
      analyzerName: analyzer.analyzerName,
      ruleName: FIXTURE_RULE_NAME,
      filter: { findingType: { eq: ["UnusedIAMRole"] } },
    });

    // --- analyzer-scoped bindings ---
    const listFindingsV2 = yield* AccessAnalyzer.ListFindingsV2(analyzer);
    const getFindingsStatistics =
      yield* AccessAnalyzer.GetFindingsStatistics(analyzer);
    const applyArchiveRule = yield* AccessAnalyzer.ApplyArchiveRule(analyzer);
    // Bound (compile + IAM coverage) but not routed: these need live
    // findings, access previews, or an external-access analyzer to drive
    // deterministically.
    const listFindingsV1 = yield* AccessAnalyzer.ListFindings(analyzer);
    const getFindingV2 = yield* AccessAnalyzer.GetFindingV2(analyzer);
    const getFindingV1 = yield* AccessAnalyzer.GetFinding(analyzer);
    const updateFindings = yield* AccessAnalyzer.UpdateFindings(analyzer);
    const startResourceScan = yield* AccessAnalyzer.StartResourceScan(analyzer);
    const getAnalyzedResource =
      yield* AccessAnalyzer.GetAnalyzedResource(analyzer);
    const listAnalyzedResources =
      yield* AccessAnalyzer.ListAnalyzedResources(analyzer);
    const createAccessPreview =
      yield* AccessAnalyzer.CreateAccessPreview(analyzer);
    const getAccessPreview = yield* AccessAnalyzer.GetAccessPreview(analyzer);
    const listAccessPreviews =
      yield* AccessAnalyzer.ListAccessPreviews(analyzer);
    const listAccessPreviewFindings =
      yield* AccessAnalyzer.ListAccessPreviewFindings(analyzer);
    const generateFindingRecommendation =
      yield* AccessAnalyzer.GenerateFindingRecommendation(analyzer);
    const getFindingRecommendation =
      yield* AccessAnalyzer.GetFindingRecommendation(analyzer);

    // --- account-level bindings ---
    const validatePolicy = yield* AccessAnalyzer.ValidatePolicy();
    const checkAccessNotGranted = yield* AccessAnalyzer.CheckAccessNotGranted();
    const checkNoNewAccess = yield* AccessAnalyzer.CheckNoNewAccess();
    const checkNoPublicAccess = yield* AccessAnalyzer.CheckNoPublicAccess();
    const startPolicyGeneration = yield* AccessAnalyzer.StartPolicyGeneration();
    const getGeneratedPolicy = yield* AccessAnalyzer.GetGeneratedPolicy();
    const listPolicyGenerations = yield* AccessAnalyzer.ListPolicyGenerations();
    const cancelPolicyGeneration =
      yield* AccessAnalyzer.CancelPolicyGeneration();

    // --- event source ---
    // Deploy-time: creates the EventBridge rule (default bus) targeting this
    // Function. Runtime firing needs a real finding, so the test only
    // verifies the subscription deploys cleanly.
    yield* AccessAnalyzer.consumeFindings({ kind: "all" }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(`access-analyzer finding event: ${event.detail.id}`),
      ),
    );

    const bound = {
      listFindingsV2,
      listFindingsV1,
      getFindingV2,
      getFindingV1,
      getFindingsStatistics,
      updateFindings,
      applyArchiveRule,
      startResourceScan,
      getAnalyzedResource,
      listAnalyzedResources,
      createAccessPreview,
      getAccessPreview,
      listAccessPreviews,
      listAccessPreviewFindings,
      generateFindingRecommendation,
      getFindingRecommendation,
      validatePolicy,
      checkAccessNotGranted,
      checkNoNewAccess,
      checkNoPublicAccess,
      startPolicyGeneration,
      getGeneratedPolicy,
      listPolicyGenerations,
      cancelPolicyGeneration,
    };

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

        if (request.method === "GET" && pathname === "/list-findings") {
          const result = yield* listFindingsV2({ maxResults: 25 });
          return yield* HttpServerResponse.json({
            count: result.findings.length,
            nextToken: result.nextToken ?? null,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/list-analyzed-resources"
        ) {
          const result = yield* listAnalyzedResources({ maxResults: 25 });
          return yield* HttpServerResponse.json({
            count: result.analyzedResources.length,
          });
        }

        if (request.method === "GET" && pathname === "/get-finding-not-found") {
          // Exercises analyzerArn injection + the typed not-found error path.
          const result = yield* getFindingV2({
            id: "00000000-0000-0000-0000-000000000000",
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ found: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/findings-statistics") {
          const result = yield* getFindingsStatistics();
          return yield* HttpServerResponse.json({
            statistics: result.findingsStatistics ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/apply-archive-rule") {
          yield* applyArchiveRule({ ruleName: FIXTURE_RULE_NAME });
          return yield* HttpServerResponse.json({ applied: true });
        }

        if (request.method === "POST" && pathname === "/validate-policy") {
          const result = yield* validatePolicy({
            policyDocument: IDENTITY_POLICY,
            policyType: "IDENTITY_POLICY",
          });
          return yield* HttpServerResponse.json({
            findingTypes: result.findings.map((f) => f.findingType),
          });
        }

        if (request.method === "POST" && pathname === "/check-no-new-access") {
          const result = yield* checkNoNewAccess({
            existingPolicyDocument: WIDER_IDENTITY_POLICY,
            newPolicyDocument: IDENTITY_POLICY,
            policyType: "IDENTITY_POLICY",
          });
          return yield* HttpServerResponse.json({ result: result.result });
        }

        if (
          request.method === "POST" &&
          pathname === "/check-access-not-granted"
        ) {
          const result = yield* checkAccessNotGranted({
            policyDocument: IDENTITY_POLICY,
            policyType: "IDENTITY_POLICY",
            access: [{ actions: ["s3:DeleteBucket"] }],
          });
          return yield* HttpServerResponse.json({ result: result.result });
        }

        if (
          request.method === "POST" &&
          pathname === "/check-no-public-access"
        ) {
          const result = yield* checkNoPublicAccess({
            policyDocument: PRIVATE_BUCKET_POLICY,
            resourceType: "AWS::S3::Bucket",
          });
          return yield* HttpServerResponse.json({ result: result.result });
        }

        if (
          request.method === "GET" &&
          pathname === "/list-policy-generations"
        ) {
          const result = yield* listPolicyGenerations();
          return yield* HttpServerResponse.json({
            count: result.policyGenerations.length,
          });
        }

        if (request.method === "POST" && pathname === "/policy-generation") {
          // The live API rejects StartPolicyGeneration without
          // `cloudTrailDetails` ("Missing cloudTrailDetails"); a real
          // generation needs a CloudTrail trail + an access role Access
          // Analyzer can assume — external infra out of scope for a binding
          // test. Drive all three bindings through their typed
          // ValidationException paths instead: an IAM gap would surface
          // AccessDeniedException, so a ValidationException proves the grant
          // and the typed error union end-to-end.
          const body = (yield* request.json) as unknown as {
            principalArn: string;
          };
          const startTag = yield* startPolicyGeneration({
            policyGenerationDetails: { principalArn: body.principalArn },
          }).pipe(
            // If AWS ever accepts trail-less generation again, cancel the
            // job so nothing dangles.
            Effect.flatMap(({ jobId }) =>
              cancelPolicyGeneration({ jobId }).pipe(
                Effect.catchTag("ValidationException", () => Effect.void),
                Effect.as("Started"),
              ),
            ),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const bogusJob = { jobId: "00000000-0000-0000-0000-000000000000" };
          const getTag = yield* getGeneratedPolicy(bogusJob).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const cancelTag = yield* cancelPolicyGeneration(bogusJob).pipe(
            Effect.map(() => "Canceled"),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            startTag,
            getTag,
            cancelTag,
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
        Lambda.EventSource,
        AccessAnalyzer.ListFindingsV2Http,
        AccessAnalyzer.ListFindingsHttp,
        AccessAnalyzer.GetFindingV2Http,
        AccessAnalyzer.GetFindingHttp,
        AccessAnalyzer.GetFindingsStatisticsHttp,
        AccessAnalyzer.UpdateFindingsHttp,
        AccessAnalyzer.ApplyArchiveRuleHttp,
        AccessAnalyzer.StartResourceScanHttp,
        AccessAnalyzer.GetAnalyzedResourceHttp,
        AccessAnalyzer.ListAnalyzedResourcesHttp,
        AccessAnalyzer.CreateAccessPreviewHttp,
        AccessAnalyzer.GetAccessPreviewHttp,
        AccessAnalyzer.ListAccessPreviewsHttp,
        AccessAnalyzer.ListAccessPreviewFindingsHttp,
        AccessAnalyzer.GenerateFindingRecommendationHttp,
        AccessAnalyzer.GetFindingRecommendationHttp,
        AccessAnalyzer.ValidatePolicyHttp,
        AccessAnalyzer.CheckAccessNotGrantedHttp,
        AccessAnalyzer.CheckNoNewAccessHttp,
        AccessAnalyzer.CheckNoPublicAccessHttp,
        AccessAnalyzer.StartPolicyGenerationHttp,
        AccessAnalyzer.GetGeneratedPolicyHttp,
        AccessAnalyzer.ListPolicyGenerationsHttp,
        AccessAnalyzer.CancelPolicyGenerationHttp,
      ),
    ),
  ),
);

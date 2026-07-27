import * as Config from "@/AWS/Config";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ConfigTestFunction extends Lambda.Function<Lambda.Function>()(
  "ConfigTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts the tag is in a
 * route-specific allowlist, which proves both the binding wiring and the
 * IAM grant. An untyped error crashes into a 500 instead.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string; errorMessage?: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string; errorMessage?: string } => a),
    Effect.catch((e) =>
      Effect.succeed({
        errorTag: e._tag,
        errorMessage:
          (e as { Message?: string }).Message ??
          (e as { message?: string }).message,
      }),
    ),
  );

// One binding per Config capability. DeliverConfigSnapshot has no route
// here: it binds to the account's singleton DeliveryChannel, whose
// lifecycle is gated behind AWS_TEST_CONFIG_RECORDER (see
// ConfigurationRecorder.test.ts) — deploying a second channel ungated
// would clobber the account setup.
export default ConfigTestFunction.make(
  {
    main,
    url: true,
    // Several routes fan out Config API calls — AWS's 3s default
    // intermittently times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A managed rule the rule-scoped bindings are bound to. Requires a
    // configuration recorder in the account/region — the test's beforeAll
    // stands one up out-of-band before deploying this fixture.
    const rule = yield* Config.ConfigRule("BindingRule", {
      description: "alchemy config-bindings fixture rule",
      source: {
        owner: "AWS",
        sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
      },
      scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
    });

    // Event source: subscribe the host to Config compliance-change events.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* Config.consumeConfigEvents({ kinds: ["compliance"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `config compliance: ${event.detail.configRuleName} -> ${event.detail.resourceId}`,
        ),
      ),
    );

    // Account-level bindings.
    const batchGetResourceConfig = yield* Config.BatchGetResourceConfig();
    const getResourceConfigHistory = yield* Config.GetResourceConfigHistory();
    const listDiscoveredResources = yield* Config.ListDiscoveredResources();
    const getDiscoveredResourceCounts =
      yield* Config.GetDiscoveredResourceCounts();
    const selectResourceConfig = yield* Config.SelectResourceConfig();
    const describeComplianceByConfigRule =
      yield* Config.DescribeComplianceByConfigRule();
    const describeComplianceByResource =
      yield* Config.DescribeComplianceByResource();
    const getComplianceDetailsByResource =
      yield* Config.GetComplianceDetailsByResource();
    const getComplianceSummaryByConfigRule =
      yield* Config.GetComplianceSummaryByConfigRule();
    const getComplianceSummaryByResourceType =
      yield* Config.GetComplianceSummaryByResourceType();
    const describeConfigRuleEvaluationStatus =
      yield* Config.DescribeConfigRuleEvaluationStatus();
    const putEvaluations = yield* Config.PutEvaluations();
    const putResourceConfig = yield* Config.PutResourceConfig();
    const deleteResourceConfig = yield* Config.DeleteResourceConfig();
    const startResourceEvaluation = yield* Config.StartResourceEvaluation();
    const getResourceEvaluationSummary =
      yield* Config.GetResourceEvaluationSummary();
    const listResourceEvaluations = yield* Config.ListResourceEvaluations();

    // Rule-scoped bindings (the rule name is injected automatically).
    const getComplianceDetailsByConfigRule =
      yield* Config.GetComplianceDetailsByConfigRule(rule);
    const startConfigRulesEvaluation =
      yield* Config.StartConfigRulesEvaluation(rule);
    const putExternalEvaluation = yield* Config.PutExternalEvaluation(rule);

    const RuleName = yield* rule.configRuleName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const route = `${request.method} ${url.pathname}`;

        switch (route) {
          case "GET /health":
            return HttpServerResponse.text("ok");

          // ── Discovering resources / querying ──────────────────────────

          case "GET /select-resource-config": {
            const result = yield* selectResourceConfig({
              Expression:
                "SELECT resourceId WHERE resourceType = 'AWS::S3::Bucket'",
            });
            return yield* HttpServerResponse.json({
              results: result.Results ?? [],
            });
          }
          case "GET /list-discovered-resources": {
            const result = yield* listDiscoveredResources({
              resourceType: "AWS::S3::Bucket",
            });
            return yield* HttpServerResponse.json({
              identifiers: result.resourceIdentifiers ?? [],
            });
          }
          case "GET /get-discovered-resource-counts": {
            const result = yield* getDiscoveredResourceCounts();
            return yield* HttpServerResponse.json({
              total: result.totalDiscoveredResources ?? 0,
              counts: result.resourceCounts ?? [],
            });
          }
          case "POST /batch-get-resource-config": {
            const result = yield* batchGetResourceConfig({
              resourceKeys: [
                {
                  resourceType: "AWS::S3::Bucket",
                  resourceId: "alchemy-nonexistent-bucket-probe",
                },
              ],
            });
            return yield* HttpServerResponse.json({
              items: result.baseConfigurationItems ?? [],
              unprocessed: result.unprocessedResourceKeys ?? [],
            });
          }
          case "GET /get-resource-config-history": {
            // The probe resource is never discovered — the typed
            // ResourceNotDiscoveredException proves binding + IAM.
            const result = yield* errorTagged(
              getResourceConfigHistory({
                resourceType: "AWS::S3::Bucket",
                resourceId: "alchemy-nonexistent-bucket-probe",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { items: result.configurationItems ?? [] },
            );
          }

          // ── Compliance reads ───────────────────────────────────────────

          case "GET /describe-compliance-by-config-rule": {
            const ruleName = yield* RuleName;
            const result = yield* describeComplianceByConfigRule({
              ConfigRuleNames: [ruleName],
            });
            return yield* HttpServerResponse.json({
              ruleName,
              compliances: result.ComplianceByConfigRules ?? [],
            });
          }
          case "GET /describe-compliance-by-resource": {
            const result = yield* describeComplianceByResource({
              ResourceType: "AWS::S3::Bucket",
            });
            return yield* HttpServerResponse.json({
              compliances: result.ComplianceByResources ?? [],
            });
          }
          case "GET /get-compliance-details-by-resource": {
            const result = yield* getComplianceDetailsByResource({
              ResourceType: "AWS::S3::Bucket",
              ResourceId: "alchemy-nonexistent-bucket-probe",
            });
            return yield* HttpServerResponse.json({
              evaluations: result.EvaluationResults ?? [],
            });
          }
          case "GET /get-compliance-summary-by-config-rule": {
            const result = yield* getComplianceSummaryByConfigRule();
            return yield* HttpServerResponse.json({
              summary: result.ComplianceSummary ?? null,
            });
          }
          case "GET /get-compliance-summary-by-resource-type": {
            const result = yield* getComplianceSummaryByResourceType();
            return yield* HttpServerResponse.json({
              summaries: result.ComplianceSummariesByResourceType ?? [],
            });
          }
          case "GET /get-compliance-details-by-config-rule": {
            const result = yield* getComplianceDetailsByConfigRule();
            return yield* HttpServerResponse.json({
              ruleName: yield* RuleName,
              evaluations: result.EvaluationResults ?? [],
            });
          }

          // ── Rule evaluation ────────────────────────────────────────────

          case "GET /describe-config-rule-evaluation-status": {
            const ruleName = yield* RuleName;
            const result = yield* describeConfigRuleEvaluationStatus({
              ConfigRuleNames: [ruleName],
            });
            return yield* HttpServerResponse.json({
              ruleName,
              statuses: (result.ConfigRulesEvaluationStatus ?? []).map(
                (s) => s.ConfigRuleName,
              ),
            });
          }
          case "POST /start-config-rules-evaluation": {
            // Back-to-back runs can reject with ResourceInUseException /
            // LimitExceededException — typed either way.
            const result = yield* errorTagged(startConfigRulesEvaluation());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "POST /put-evaluations": {
            // TestMode validates the evaluations without pushing them; an
            // out-of-band token can still reject with the typed
            // InvalidResultTokenException.
            const result = yield* errorTagged(
              putEvaluations({
                ResultToken: "alchemy-config-bindings-test-token",
                TestMode: true,
                Evaluations: [
                  {
                    ComplianceResourceType: "AWS::S3::Bucket",
                    ComplianceResourceId: "alchemy-nonexistent-bucket-probe",
                    ComplianceType: "COMPLIANT",
                    OrderingTimestamp: new Date(),
                  },
                ],
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { failed: result.FailedEvaluations ?? [] },
            );
          }
          case "POST /put-external-evaluation": {
            // The fixture rule is a managed rule, not an external-evaluation
            // rule — the typed InvalidParameterValueException proves binding
            // + IAM.
            const result = yield* errorTagged(
              putExternalEvaluation({
                ExternalEvaluation: {
                  ComplianceResourceType: "AWS::S3::Bucket",
                  ComplianceResourceId: "alchemy-nonexistent-bucket-probe",
                  ComplianceType: "NOT_APPLICABLE",
                  OrderingTimestamp: new Date(),
                },
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          // ── Custom resource recording ──────────────────────────────────

          case "POST /put-resource-config": {
            // Recording a third-party type requires a running recorder —
            // NoRunningConfigurationRecorderException is typed and proves
            // binding + IAM when the fixture recorder is stopped.
            const result = yield* errorTagged(
              putResourceConfig({
                ResourceType: "MyCompany::Alchemy::Fixture",
                SchemaVersionId: "1.0",
                ResourceId: "alchemy-config-bindings-fixture",
                Configuration: JSON.stringify({ fixture: true }),
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "POST /delete-resource-config": {
            const result = yield* errorTagged(
              deleteResourceConfig({
                ResourceType: "MyCompany::Alchemy::Fixture",
                ResourceId: "alchemy-config-bindings-fixture",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          // ── Proactive resource evaluation ──────────────────────────────

          case "POST /start-resource-evaluation": {
            const result = yield* errorTagged(
              startResourceEvaluation({
                EvaluationMode: "PROACTIVE",
                ResourceDetails: {
                  ResourceId: "alchemy-config-bindings-proactive",
                  ResourceType: "AWS::S3::Bucket",
                  ResourceConfiguration: JSON.stringify({
                    BucketName: "alchemy-config-bindings-proactive",
                  }),
                  ResourceConfigurationSchemaType: "CFN_RESOURCE_SCHEMA",
                },
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { id: result.ResourceEvaluationId },
            );
          }
          case "GET /get-resource-evaluation-summary": {
            const id = url.searchParams.get("id") ?? "";
            const result = yield* errorTagged(
              getResourceEvaluationSummary({ ResourceEvaluationId: id }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    id: result.ResourceEvaluationId,
                    status: result.EvaluationStatus?.Status,
                  },
            );
          }
          case "GET /list-resource-evaluations": {
            const result = yield* listResourceEvaluations({
              Filters: { EvaluationMode: "PROACTIVE" },
            });
            return yield* HttpServerResponse.json({
              evaluations: result.ResourceEvaluations ?? [],
            });
          }

          default:
            return yield* HttpServerResponse.json(
              { error: "Not found", route },
              { status: 404 },
            );
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Config.BatchGetResourceConfigHttp,
        Config.DeleteResourceConfigHttp,
        Config.DescribeComplianceByConfigRuleHttp,
        Config.DescribeComplianceByResourceHttp,
        Config.DescribeConfigRuleEvaluationStatusHttp,
        Config.GetComplianceDetailsByConfigRuleHttp,
        Config.GetComplianceDetailsByResourceHttp,
        Config.GetComplianceSummaryByConfigRuleHttp,
        Config.GetComplianceSummaryByResourceTypeHttp,
        Config.GetDiscoveredResourceCountsHttp,
        Config.GetResourceConfigHistoryHttp,
        Config.GetResourceEvaluationSummaryHttp,
        Config.ListDiscoveredResourcesHttp,
        Config.ListResourceEvaluationsHttp,
        Config.PutEvaluationsHttp,
        Config.PutExternalEvaluationHttp,
        Config.PutResourceConfigHttp,
        Config.SelectResourceConfigHttp,
        Config.StartConfigRulesEvaluationHttp,
        Config.StartResourceEvaluationHttp,
      ),
    ),
  ),
);

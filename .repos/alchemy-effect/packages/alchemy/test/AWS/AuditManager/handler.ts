import * as AuditManager from "@/AWS/AuditManager";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent control domain id — drives the typed error
// path for ListControlInsightsByControlDomain.
const NONEXISTENT_CONTROL_DOMAIN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

export class AuditManagerTestFunction extends Lambda.Function<Lambda.Function>()(
  "AuditManagerTestFunction",
) {}

/**
 * Account-level Audit Manager bindings fixture.
 *
 * The testing account is NOT registered with Audit Manager (the service
 * entered maintenance mode on 2026-04-30, so it can never be registered).
 * `GetAccountStatus` still succeeds on unregistered accounts — proving a
 * real end-to-end success through the binding + attached IAM policy — while
 * every other operation answers the typed `AccessDeniedException`, proving
 * the wiring and typed error union for each capability.
 */
export default AuditManagerTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const getAccountStatus = yield* AuditManager.GetAccountStatus();
    const getServicesInScope = yield* AuditManager.GetServicesInScope();
    const getInsights = yield* AuditManager.GetInsights();
    const listControlDomainInsights =
      yield* AuditManager.ListControlDomainInsights();
    const listControlInsightsByControlDomain =
      yield* AuditManager.ListControlInsightsByControlDomain();
    const getDelegations = yield* AuditManager.GetDelegations();
    const getEvidenceFileUploadUrl =
      yield* AuditManager.GetEvidenceFileUploadUrl();
    const listAssessmentReports = yield* AuditManager.ListAssessmentReports();
    const validateAssessmentReportIntegrity =
      yield* AuditManager.ValidateAssessmentReportIntegrity();
    const listKeywordsForDataSource =
      yield* AuditManager.ListKeywordsForDataSource();
    const listNotifications = yield* AuditManager.ListNotifications();

    const bound = {
      getAccountStatus,
      getServicesInScope,
      getInsights,
      listControlDomainInsights,
      listControlInsightsByControlDomain,
      getDelegations,
      getEvidenceFileUploadUrl,
      listAssessmentReports,
      validateAssessmentReportIntegrity,
      listKeywordsForDataSource,
      listNotifications,
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

        if (request.method === "GET" && pathname === "/account-status") {
          // Succeeds even on unregistered accounts — a REAL success through
          // the binding's IAM grant.
          const result = yield* getAccountStatus();
          return yield* HttpServerResponse.json({
            ok: true,
            status: result.status ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/services-in-scope") {
          const result = yield* getServicesInScope().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: (r.serviceMetadata ?? []).length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ValidationException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/insights") {
          const result = yield* getInsights().pipe(
            Effect.map((r) => ({
              ok: true as const,
              activeAssessmentsCount: r.insights?.activeAssessmentsCount ?? 0,
            })),
            Effect.catchTag("AccessDeniedException", (e) =>
              Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/control-domain-insights"
        ) {
          const result = yield* listControlDomainInsights({
            maxResults: 20,
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: (r.controlDomainInsights ?? []).length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/control-insights") {
          const result = yield* listControlInsightsByControlDomain({
            controlDomainId: NONEXISTENT_CONTROL_DOMAIN,
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: (r.controlInsightsMetadata ?? []).length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/delegations") {
          const result = yield* getDelegations({ maxResults: 20 }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: (r.delegations ?? []).length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ValidationException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/upload-url") {
          const result = yield* getEvidenceFileUploadUrl({
            fileName: "alchemy-evidence.txt",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              hasUrl: typeof r.uploadUrl === "string",
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ThrottlingException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/reports") {
          const result = yield* listAssessmentReports({ maxResults: 20 }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: (r.assessmentReports ?? []).length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ValidationException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/validate-report") {
          const result = yield* validateAssessmentReportIntegrity({
            s3RelativePath: "s3://alchemy-nonexistent-bucket/report.zip",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              valid: r.signatureValid ?? false,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/keywords") {
          const result = yield* listKeywordsForDataSource({
            source: "AWS_Cloudtrail",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: (r.keywords ?? []).length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ValidationException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/notifications") {
          const result = yield* listNotifications({ maxResults: 20 }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: (r.notifications ?? []).length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ValidationException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
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
        AuditManager.GetAccountStatusHttp,
        AuditManager.GetServicesInScopeHttp,
        AuditManager.GetInsightsHttp,
        AuditManager.ListControlDomainInsightsHttp,
        AuditManager.ListControlInsightsByControlDomainHttp,
        AuditManager.GetDelegationsHttp,
        AuditManager.GetEvidenceFileUploadUrlHttp,
        AuditManager.ListAssessmentReportsHttp,
        AuditManager.ValidateAssessmentReportIntegrityHttp,
        AuditManager.ListKeywordsForDataSourceHttp,
        AuditManager.ListNotificationsHttp,
      ),
    ),
  ),
);

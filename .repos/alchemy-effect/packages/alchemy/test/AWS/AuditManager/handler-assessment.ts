import * as AuditManager from "@/AWS/AuditManager";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler-assessment.ts");

export class AuditManagerAssessmentTestFunction extends Lambda.Function<Lambda.Function>()(
  "AuditManagerAssessmentTestFunction",
) {}

/**
 * Assessment-scoped Audit Manager bindings fixture.
 *
 * Requires an account registered with Audit Manager — gated behind
 * `AWS_TEST_AUDITMANAGER=1` because the service entered maintenance mode on
 * 2026-04-30 and unregistered accounts can never be registered.
 *
 * All 22 assessment-scoped capabilities are bound (so their deploy-time IAM
 * registration is exercised); the read-only ones are additionally driven
 * over HTTP.
 */
export default AuditManagerAssessmentTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const control = yield* AuditManager.Control("BindingsControl", {
      description: "AuditManager bindings fixture control",
      controlMappingSources: [
        {
          sourceName: "manual-evidence",
          sourceSetUpOption: "Procedural_Controls_Mapping",
          sourceType: "MANUAL",
        },
      ],
    });

    const framework = yield* AuditManager.Framework("BindingsFramework", {
      description: "AuditManager bindings fixture framework",
      controlSets: [
        { name: "Operations", controls: [{ id: control.controlId }] },
      ],
    });

    const reports = yield* Bucket("BindingsReports", { forceDestroy: true });

    const owner = yield* IAM.Role("BindingsAuditOwner", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: ["auditmanager.amazonaws.com"] },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });

    const assessment = yield* AuditManager.Assessment("BindingsAssessment", {
      description: "AuditManager bindings fixture assessment",
      frameworkId: framework.frameworkId,
      assessmentReportsDestination: {
        destination: Output.interpolate`s3://${reports.bucketName}`,
      },
      roles: [{ roleType: "PROCESS_OWNER", roleArn: owner.roleArn }],
    });

    // --- reads ---
    const getEvidence = yield* AuditManager.GetEvidence(assessment);
    const getEvidenceByEvidenceFolder =
      yield* AuditManager.GetEvidenceByEvidenceFolder(assessment);
    const getEvidenceFolder = yield* AuditManager.GetEvidenceFolder(assessment);
    const getEvidenceFoldersByAssessment =
      yield* AuditManager.GetEvidenceFoldersByAssessment(assessment);
    const getEvidenceFoldersByAssessmentControl =
      yield* AuditManager.GetEvidenceFoldersByAssessmentControl(assessment);
    const getChangeLogs = yield* AuditManager.GetChangeLogs(assessment);
    const getInsightsByAssessment =
      yield* AuditManager.GetInsightsByAssessment(assessment);
    const listControlDomainInsightsByAssessment =
      yield* AuditManager.ListControlDomainInsightsByAssessment(assessment);
    const listAssessmentControlInsightsByControlDomain =
      yield* AuditManager.ListAssessmentControlInsightsByControlDomain(
        assessment,
      );

    // --- evidence + reports ---
    const batchImportEvidenceToAssessmentControl =
      yield* AuditManager.BatchImportEvidenceToAssessmentControl(assessment);
    const createAssessmentReport =
      yield* AuditManager.CreateAssessmentReport(assessment);
    const deleteAssessmentReport =
      yield* AuditManager.DeleteAssessmentReport(assessment);
    const getAssessmentReportUrl =
      yield* AuditManager.GetAssessmentReportUrl(assessment);
    const associateAssessmentReportEvidenceFolder =
      yield* AuditManager.AssociateAssessmentReportEvidenceFolder(assessment);
    const disassociateAssessmentReportEvidenceFolder =
      yield* AuditManager.DisassociateAssessmentReportEvidenceFolder(
        assessment,
      );
    const batchAssociateAssessmentReportEvidence =
      yield* AuditManager.BatchAssociateAssessmentReportEvidence(assessment);
    const batchDisassociateAssessmentReportEvidence =
      yield* AuditManager.BatchDisassociateAssessmentReportEvidence(assessment);

    // --- delegations + workflow ---
    const batchCreateDelegationByAssessment =
      yield* AuditManager.BatchCreateDelegationByAssessment(assessment);
    const batchDeleteDelegationByAssessment =
      yield* AuditManager.BatchDeleteDelegationByAssessment(assessment);
    const updateAssessmentControl =
      yield* AuditManager.UpdateAssessmentControl(assessment);
    const updateAssessmentControlSetStatus =
      yield* AuditManager.UpdateAssessmentControlSetStatus(assessment);
    const updateAssessmentStatus =
      yield* AuditManager.UpdateAssessmentStatus(assessment);

    const bound = {
      getEvidence,
      getEvidenceByEvidenceFolder,
      getEvidenceFolder,
      getEvidenceFoldersByAssessment,
      getEvidenceFoldersByAssessmentControl,
      getChangeLogs,
      getInsightsByAssessment,
      listControlDomainInsightsByAssessment,
      listAssessmentControlInsightsByControlDomain,
      batchImportEvidenceToAssessmentControl,
      createAssessmentReport,
      deleteAssessmentReport,
      getAssessmentReportUrl,
      associateAssessmentReportEvidenceFolder,
      disassociateAssessmentReportEvidenceFolder,
      batchAssociateAssessmentReportEvidence,
      batchDisassociateAssessmentReportEvidence,
      batchCreateDelegationByAssessment,
      batchDeleteDelegationByAssessment,
      updateAssessmentControl,
      updateAssessmentControlSetStatus,
      updateAssessmentStatus,
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

        if (request.method === "GET" && pathname === "/evidence-folders") {
          const result = yield* getEvidenceFoldersByAssessment({
            maxResults: 20,
          });
          return yield* HttpServerResponse.json({
            count: (result.evidenceFolders ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/insights") {
          const result = yield* getInsightsByAssessment();
          return yield* HttpServerResponse.json({
            totalAssessmentControlsCount:
              result.insights?.totalAssessmentControlsCount ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/changelogs") {
          const result = yield* getChangeLogs({ maxResults: 20 });
          return yield* HttpServerResponse.json({
            count: (result.changeLogs ?? []).length,
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
        AuditManager.GetEvidenceHttp,
        AuditManager.GetEvidenceByEvidenceFolderHttp,
        AuditManager.GetEvidenceFolderHttp,
        AuditManager.GetEvidenceFoldersByAssessmentHttp,
        AuditManager.GetEvidenceFoldersByAssessmentControlHttp,
        AuditManager.GetChangeLogsHttp,
        AuditManager.GetInsightsByAssessmentHttp,
        AuditManager.ListControlDomainInsightsByAssessmentHttp,
        AuditManager.ListAssessmentControlInsightsByControlDomainHttp,
        AuditManager.BatchImportEvidenceToAssessmentControlHttp,
        AuditManager.CreateAssessmentReportHttp,
        AuditManager.DeleteAssessmentReportHttp,
        AuditManager.GetAssessmentReportUrlHttp,
        AuditManager.AssociateAssessmentReportEvidenceFolderHttp,
        AuditManager.DisassociateAssessmentReportEvidenceFolderHttp,
        AuditManager.BatchAssociateAssessmentReportEvidenceHttp,
        AuditManager.BatchDisassociateAssessmentReportEvidenceHttp,
        AuditManager.BatchCreateDelegationByAssessmentHttp,
        AuditManager.BatchDeleteDelegationByAssessmentHttp,
        AuditManager.UpdateAssessmentControlHttp,
        AuditManager.UpdateAssessmentControlSetStatusHttp,
        AuditManager.UpdateAssessmentStatusHttp,
      ),
    ),
  ),
);

import * as Inspector2 from "@/AWS/Inspector2";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class Inspector2TestFunction extends Lambda.Function<Lambda.Function>()(
  "Inspector2TestFunction",
) {}

/**
 * Routes answer `{ …fields }` on success or `{ errorTag }` when the
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
          (e as { message?: string }).message ??
          (e as { Message?: string }).Message,
      }),
    ),
  );

// One binding per Inspector2 capability. Write/org-admin operations with
// irreversible or cross-account side effects (UpdateConfiguration changes
// account scan settings; AssociateMember / Enable-DisableDelegatedAdmin
// require an organization; UpdateEncryptionKey re-keys scan results) are
// bound — proving init + IAM deploy — but not exercised against live state.
export default Inspector2TestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Findings & code snippets
    const listFindings = yield* Inspector2.ListFindings();
    const listFindingAggregations = yield* Inspector2.ListFindingAggregations();
    const batchGetFindingDetails = yield* Inspector2.BatchGetFindingDetails();
    const batchGetCodeSnippet = yield* Inspector2.BatchGetCodeSnippet();

    // Coverage & vulnerability intel
    const listCoverage = yield* Inspector2.ListCoverage();
    const listCoverageStatistics = yield* Inspector2.ListCoverageStatistics();
    const searchVulnerabilities = yield* Inspector2.SearchVulnerabilities();
    const getClustersForImage = yield* Inspector2.GetClustersForImage();

    // Findings reports & SBOM exports
    const createFindingsReport = yield* Inspector2.CreateFindingsReport();
    const getFindingsReportStatus = yield* Inspector2.GetFindingsReportStatus();
    const cancelFindingsReport = yield* Inspector2.CancelFindingsReport();
    const createSbomExport = yield* Inspector2.CreateSbomExport();
    const getSbomExport = yield* Inspector2.GetSbomExport();
    const cancelSbomExport = yield* Inspector2.CancelSbomExport();

    // CIS scan results
    const listCisScans = yield* Inspector2.ListCisScans();
    const listCisScanResultsAggregatedByChecks =
      yield* Inspector2.ListCisScanResultsAggregatedByChecks();
    const listCisScanResultsAggregatedByTargetResource =
      yield* Inspector2.ListCisScanResultsAggregatedByTargetResource();
    const getCisScanResultDetails = yield* Inspector2.GetCisScanResultDetails();
    const getCisScanReport = yield* Inspector2.GetCisScanReport();

    // Code security scans
    const startCodeSecurityScan = yield* Inspector2.StartCodeSecurityScan();
    const getCodeSecurityScan = yield* Inspector2.GetCodeSecurityScan();

    // Account settings & usage
    const listUsageTotals = yield* Inspector2.ListUsageTotals();
    const batchGetFreeTrialInfo = yield* Inspector2.BatchGetFreeTrialInfo();
    const listAccountPermissions = yield* Inspector2.ListAccountPermissions();
    const getConfiguration = yield* Inspector2.GetConfiguration();
    const updateConfiguration = yield* Inspector2.UpdateConfiguration();
    const getEc2DeepInspectionConfiguration =
      yield* Inspector2.GetEc2DeepInspectionConfiguration();
    const updateEc2DeepInspectionConfiguration =
      yield* Inspector2.UpdateEc2DeepInspectionConfiguration();
    const getEncryptionKey = yield* Inspector2.GetEncryptionKey();
    const updateEncryptionKey = yield* Inspector2.UpdateEncryptionKey();
    const resetEncryptionKey = yield* Inspector2.ResetEncryptionKey();

    // Organization & members
    const getMember = yield* Inspector2.GetMember();
    const listMembers = yield* Inspector2.ListMembers();
    const associateMember = yield* Inspector2.AssociateMember();
    const disassociateMember = yield* Inspector2.DisassociateMember();
    const getDelegatedAdminAccount =
      yield* Inspector2.GetDelegatedAdminAccount();
    const listDelegatedAdminAccounts =
      yield* Inspector2.ListDelegatedAdminAccounts();
    const enableDelegatedAdminAccount =
      yield* Inspector2.EnableDelegatedAdminAccount();
    const disableDelegatedAdminAccount =
      yield* Inspector2.DisableDelegatedAdminAccount();
    const describeOrganizationConfiguration =
      yield* Inspector2.DescribeOrganizationConfiguration();
    const updateOrganizationConfiguration =
      yield* Inspector2.UpdateOrganizationConfiguration();
    const updateOrgEc2DeepInspectionConfiguration =
      yield* Inspector2.UpdateOrgEc2DeepInspectionConfiguration();
    const batchGetMemberEc2DeepInspectionStatus =
      yield* Inspector2.BatchGetMemberEc2DeepInspectionStatus();
    const batchUpdateMemberEc2DeepInspectionStatus =
      yield* Inspector2.BatchUpdateMemberEc2DeepInspectionStatus();

    const bound = {
      listFindings,
      listFindingAggregations,
      batchGetFindingDetails,
      batchGetCodeSnippet,
      listCoverage,
      listCoverageStatistics,
      searchVulnerabilities,
      getClustersForImage,
      createFindingsReport,
      getFindingsReportStatus,
      cancelFindingsReport,
      createSbomExport,
      getSbomExport,
      cancelSbomExport,
      listCisScans,
      listCisScanResultsAggregatedByChecks,
      listCisScanResultsAggregatedByTargetResource,
      getCisScanResultDetails,
      getCisScanReport,
      startCodeSecurityScan,
      getCodeSecurityScan,
      listUsageTotals,
      batchGetFreeTrialInfo,
      listAccountPermissions,
      getConfiguration,
      updateConfiguration,
      getEc2DeepInspectionConfiguration,
      updateEc2DeepInspectionConfiguration,
      getEncryptionKey,
      updateEncryptionKey,
      resetEncryptionKey,
      getMember,
      listMembers,
      associateMember,
      disassociateMember,
      getDelegatedAdminAccount,
      listDelegatedAdminAccounts,
      enableDelegatedAdminAccount,
      disableDelegatedAdminAccount,
      describeOrganizationConfiguration,
      updateOrganizationConfiguration,
      updateOrgEc2DeepInspectionConfiguration,
      batchGetMemberEc2DeepInspectionStatus,
      batchUpdateMemberEc2DeepInspectionStatus,
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

        // Findings — works whether or not Inspector scanning is enabled
        // (an un-enabled account just has none).
        if (request.method === "GET" && pathname === "/findings") {
          const result = yield* errorTagged(
            listFindings({ maxResults: 10 }).pipe(
              Effect.map((r) => ({ count: (r.findings ?? []).length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/coverage") {
          const result = yield* errorTagged(
            listCoverage({ maxResults: 10 }).pipe(
              Effect.map((r) => ({
                count: (r.coveredResources ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Vulnerability intel — the public vulnerability database.
        if (request.method === "GET" && pathname === "/vulnerability") {
          const id = url.searchParams.get("id") ?? "CVE-2021-44228";
          const result = yield* errorTagged(
            searchVulnerabilities({
              filterCriteria: { vulnerabilityIds: [id] },
            }).pipe(
              Effect.map((r) => ({
                ids: (r.vulnerabilities ?? []).map((v) => v.id),
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/usage") {
          const result = yield* errorTagged(
            listUsageTotals({}).pipe(
              Effect.map((r) => ({ totals: (r.totals ?? []).length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/account-permissions") {
          const result = yield* errorTagged(
            listAccountPermissions({}).pipe(
              Effect.map((r) => ({
                permissions: (r.permissions ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/free-trial") {
          const account = url.searchParams.get("account") ?? "";
          const result = yield* errorTagged(
            batchGetFreeTrialInfo({ accountIds: [account] }).pipe(
              Effect.map((r) => ({
                accounts: (r.accounts ?? []).length,
                failed: (r.failedAccounts ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/config") {
          const result = yield* errorTagged(
            getConfiguration({}).pipe(
              Effect.map((r) => ({
                hasEcrConfiguration: r.ecrConfiguration !== undefined,
                hasEc2Configuration: r.ec2Configuration !== undefined,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/deep-inspection") {
          const result = yield* errorTagged(
            getEc2DeepInspectionConfiguration({}).pipe(
              Effect.map((r) => ({ status: r.status ?? "UNSET" })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/encryption-key") {
          const result = yield* errorTagged(
            getEncryptionKey({
              resourceType: "AWS_ECR_CONTAINER_IMAGE",
              scanType: "PACKAGE",
            }).pipe(Effect.map((r) => ({ kmsKeyId: r.kmsKeyId }))),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/cis-scans") {
          const result = yield* errorTagged(
            listCisScans({}).pipe(
              Effect.map((r) => ({ scans: (r.scans ?? []).length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/members") {
          const result = yield* errorTagged(
            listMembers({}).pipe(
              Effect.map((r) => ({ members: (r.members ?? []).length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Org administration: a standalone (non-organization) account gets a
        // typed rejection, which still proves the binding + IAM wiring.
        if (request.method === "GET" && pathname === "/org-config") {
          const result = yield* errorTagged(
            describeOrganizationConfiguration({}).pipe(
              Effect.map((r) => ({
                maxAccountLimitReached: r.maxAccountLimitReached ?? false,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/delegated-admin") {
          const result = yield* errorTagged(
            getDelegatedAdminAccount({}).pipe(
              Effect.map((r) => ({
                accountId: r.delegatedAdmin?.accountId,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Report status for a well-formed but nonexistent report id — a
        // typed ResourceNotFoundException proves the binding end-to-end.
        if (request.method === "GET" && pathname === "/report-status") {
          const result = yield* errorTagged(
            getFindingsReportStatus({
              reportId:
                url.searchParams.get("id") ??
                "00000000-0000-0000-0000-000000000000",
            }).pipe(Effect.map((r) => ({ status: r.status }))),
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
        Inspector2.AssociateMemberHttp,
        Inspector2.BatchGetCodeSnippetHttp,
        Inspector2.BatchGetFindingDetailsHttp,
        Inspector2.BatchGetFreeTrialInfoHttp,
        Inspector2.BatchGetMemberEc2DeepInspectionStatusHttp,
        Inspector2.BatchUpdateMemberEc2DeepInspectionStatusHttp,
        Inspector2.CancelFindingsReportHttp,
        Inspector2.CancelSbomExportHttp,
        Inspector2.CreateFindingsReportHttp,
        Inspector2.CreateSbomExportHttp,
        Inspector2.DescribeOrganizationConfigurationHttp,
        Inspector2.DisableDelegatedAdminAccountHttp,
        Inspector2.DisassociateMemberHttp,
        Inspector2.EnableDelegatedAdminAccountHttp,
        Inspector2.GetCisScanReportHttp,
        Inspector2.GetCisScanResultDetailsHttp,
        Inspector2.GetClustersForImageHttp,
        Inspector2.GetCodeSecurityScanHttp,
        Inspector2.GetConfigurationHttp,
        Inspector2.GetDelegatedAdminAccountHttp,
        Inspector2.GetEc2DeepInspectionConfigurationHttp,
        Inspector2.GetEncryptionKeyHttp,
        Inspector2.GetFindingsReportStatusHttp,
        Inspector2.GetMemberHttp,
        Inspector2.GetSbomExportHttp,
        Inspector2.ListAccountPermissionsHttp,
        Inspector2.ListCisScanResultsAggregatedByChecksHttp,
        Inspector2.ListCisScanResultsAggregatedByTargetResourceHttp,
        Inspector2.ListCisScansHttp,
        Inspector2.ListCoverageHttp,
        Inspector2.ListCoverageStatisticsHttp,
        Inspector2.ListDelegatedAdminAccountsHttp,
        Inspector2.ListFindingAggregationsHttp,
        Inspector2.ListFindingsHttp,
        Inspector2.ListMembersHttp,
        Inspector2.ListUsageTotalsHttp,
        Inspector2.ResetEncryptionKeyHttp,
        Inspector2.SearchVulnerabilitiesHttp,
        Inspector2.StartCodeSecurityScanHttp,
        Inspector2.UpdateConfigurationHttp,
        Inspector2.UpdateEc2DeepInspectionConfigurationHttp,
        Inspector2.UpdateEncryptionKeyHttp,
        Inspector2.UpdateOrgEc2DeepInspectionConfigurationHttp,
        Inspector2.UpdateOrganizationConfigurationHttp,
      ),
    ),
  ),
);

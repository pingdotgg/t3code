import * as GuardDuty from "@/AWS/GuardDuty";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GuardDutyTestFunction extends Lambda.Function<Lambda.Function>()(
  "GuardDutyTestFunction",
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
          (e as { Message?: string }).Message ??
          (e as { message?: string }).message,
      }),
    ),
  );

// One binding per exercised GuardDuty capability, spanning both scaffolding
// shapes: detector-scoped (DetectorId injected from the bound Detector) and
// account-level (request passed as-is). Member/org-admin writes with
// cross-account side effects (InviteMembers, EnableOrganizationAdminAccount,
// …) share the same two builders and are not re-proven here.
export default GuardDutyTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The detector every detector-scoped binding is bound to. GuardDuty
    // allows one detector per account/region — the test account keeps none
    // deployed between runs (Detector.test.ts is capture-and-restore safe).
    const detector = yield* GuardDuty.Detector("BindingsDetector", {
      findingPublishingFrequency: "FIFTEEN_MINUTES",
      tags: { fixture: "guardduty-bindings" },
    });

    // Findings triage loop
    const createSampleFindings =
      yield* GuardDuty.CreateSampleFindings(detector);
    const listFindings = yield* GuardDuty.ListFindings(detector);
    const getFindings = yield* GuardDuty.GetFindings(detector);
    const getFindingsStatistics =
      yield* GuardDuty.GetFindingsStatistics(detector);
    const archiveFindings = yield* GuardDuty.ArchiveFindings(detector);
    const unarchiveFindings = yield* GuardDuty.UnarchiveFindings(detector);
    const updateFindingsFeedback =
      yield* GuardDuty.UpdateFindingsFeedback(detector);

    // Detector-scoped reads
    const listMembers = yield* GuardDuty.ListMembers(detector);
    const getAdministratorAccount =
      yield* GuardDuty.GetAdministratorAccount(detector);
    const getMalwareScanSettings =
      yield* GuardDuty.GetMalwareScanSettings(detector);
    const getUsageStatistics = yield* GuardDuty.GetUsageStatistics(detector);
    const listCoverage = yield* GuardDuty.ListCoverage(detector);
    const getRemainingFreeTrialDays =
      yield* GuardDuty.GetRemainingFreeTrialDays(detector);
    const listInvestigations = yield* GuardDuty.ListInvestigations(detector);
    const describeOrganizationConfiguration =
      yield* GuardDuty.DescribeOrganizationConfiguration(detector);

    // Account-level (invitation flow + org administration)
    const getInvitationsCount = yield* GuardDuty.GetInvitationsCount();
    const listInvitations = yield* GuardDuty.ListInvitations();
    const listOrganizationAdminAccounts =
      yield* GuardDuty.ListOrganizationAdminAccounts();
    const getOrganizationStatistics =
      yield* GuardDuty.GetOrganizationStatistics();

    const bound = {
      createSampleFindings,
      listFindings,
      getFindings,
      getFindingsStatistics,
      archiveFindings,
      unarchiveFindings,
      updateFindingsFeedback,
      listMembers,
      getAdministratorAccount,
      getMalwareScanSettings,
      getUsageStatistics,
      listCoverage,
      getRemainingFreeTrialDays,
      listInvestigations,
      describeOrganizationConfiguration,
      getInvitationsCount,
      listInvitations,
      listOrganizationAdminAccounts,
      getOrganizationStatistics,
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

        // Generates sample findings on our own detector — the documented
        // way to exercise a findings pipeline without staging a threat.
        if (request.method === "POST" && pathname === "/sample") {
          yield* createSampleFindings({
            FindingTypes: ["Recon:EC2/PortProbeUnprotectedPort"],
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/findings") {
          const { FindingIds } = yield* listFindings();
          return yield* HttpServerResponse.json({
            count: (FindingIds ?? []).length,
            ids: (FindingIds ?? []).slice(0, 5),
          });
        }

        if (request.method === "GET" && pathname === "/finding-detail") {
          const id = url.searchParams.get("id");
          if (!id) {
            return yield* HttpServerResponse.json(
              { error: "missing id" },
              { status: 400 },
            );
          }
          const { Findings } = yield* getFindings({ FindingIds: [id] });
          return yield* HttpServerResponse.json({
            count: (Findings ?? []).length,
            type: Findings?.[0]?.Type,
            archived: Findings?.[0]?.Service?.Archived ?? false,
          });
        }

        if (request.method === "GET" && pathname === "/stats") {
          const { FindingStatistics } = yield* getFindingsStatistics({
            FindingStatisticTypes: ["COUNT_BY_SEVERITY"],
          });
          return yield* HttpServerResponse.json({
            severities: Object.keys(FindingStatistics?.CountBySeverity ?? {}),
          });
        }

        // Archive whatever findings currently exist (sample findings from
        // /sample) — a real write against our own detector.
        if (request.method === "POST" && pathname === "/archive") {
          const { FindingIds } = yield* listFindings();
          if ((FindingIds ?? []).length === 0) {
            return yield* HttpServerResponse.json({ archived: 0 });
          }
          const result = yield* errorTagged(
            archiveFindings({ FindingIds: FindingIds! }).pipe(
              Effect.map(() => ({ archived: FindingIds!.length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/members") {
          const { Members } = yield* listMembers();
          return yield* HttpServerResponse.json({
            count: (Members ?? []).length,
          });
        }

        // A standalone account has no administrator — GuardDuty answers
        // with an empty document or a typed BadRequestException.
        if (request.method === "GET" && pathname === "/admin") {
          const result = yield* errorTagged(
            getAdministratorAccount().pipe(
              Effect.map((r) => ({
                administrator: r.Administrator?.AccountId ?? null,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/malware-settings") {
          const result = yield* errorTagged(
            getMalwareScanSettings().pipe(
              Effect.map((r) => ({
                ebsSnapshotPreservation: r.EbsSnapshotPreservation ?? null,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/usage") {
          const { UsageStatistics } = yield* getUsageStatistics({
            UsageStatisticType: "SUM_BY_DATA_SOURCE",
            UsageCriteria: { DataSources: ["FLOW_LOGS"] },
          });
          return yield* HttpServerResponse.json({
            dataSources: (UsageStatistics?.SumByDataSource ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/coverage") {
          const { Resources } = yield* listCoverage();
          return yield* HttpServerResponse.json({
            resources: (Resources ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/free-trial") {
          // The smithy model requires AccountIds — the caller passes its
          // own account id.
          const account = url.searchParams.get("account");
          if (!account) {
            return yield* HttpServerResponse.json(
              { error: "missing account" },
              { status: 400 },
            );
          }
          const { Accounts } = yield* getRemainingFreeTrialDays({
            AccountIds: [account],
          });
          return yield* HttpServerResponse.json({
            accounts: (Accounts ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/investigations") {
          const result = yield* errorTagged(
            listInvestigations().pipe(
              Effect.map((r) => ({
                count: (r.Investigations ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Org administration: this account is a standalone (non-delegated)
        // account, so GuardDuty answers with a typed error — asserting the
        // tag proves the binding + IAM wiring end-to-end.
        if (request.method === "GET" && pathname === "/org-config") {
          const result = yield* errorTagged(
            describeOrganizationConfiguration().pipe(
              Effect.map((r) => ({ autoEnable: r.AutoEnable ?? false })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/org-admins") {
          const result = yield* errorTagged(
            listOrganizationAdminAccounts().pipe(
              Effect.map((r) => ({
                admins: (r.AdminAccounts ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/org-stats") {
          const result = yield* errorTagged(
            getOrganizationStatistics().pipe(
              Effect.map((r) => ({
                activeAccounts:
                  r.OrganizationDetails?.OrganizationStatistics
                    ?.ActiveAccountsCount ?? 0,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Account-level invitation reads.
        if (request.method === "GET" && pathname === "/invitations-count") {
          const { InvitationsCount } = yield* getInvitationsCount();
          return yield* HttpServerResponse.json({
            count: InvitationsCount ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/invitations") {
          const { Invitations } = yield* listInvitations();
          return yield* HttpServerResponse.json({
            count: (Invitations ?? []).length,
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
        GuardDuty.ArchiveFindingsHttp,
        GuardDuty.CreateSampleFindingsHttp,
        GuardDuty.DescribeOrganizationConfigurationHttp,
        GuardDuty.GetAdministratorAccountHttp,
        GuardDuty.GetFindingsHttp,
        GuardDuty.GetFindingsStatisticsHttp,
        GuardDuty.GetInvitationsCountHttp,
        GuardDuty.GetMalwareScanSettingsHttp,
        GuardDuty.GetOrganizationStatisticsHttp,
        GuardDuty.GetRemainingFreeTrialDaysHttp,
        GuardDuty.GetUsageStatisticsHttp,
        GuardDuty.ListCoverageHttp,
        GuardDuty.ListFindingsHttp,
        GuardDuty.ListInvestigationsHttp,
        GuardDuty.ListInvitationsHttp,
        GuardDuty.ListMembersHttp,
        GuardDuty.ListOrganizationAdminAccountsHttp,
        GuardDuty.UnarchiveFindingsHttp,
        GuardDuty.UpdateFindingsFeedbackHttp,
      ),
    ),
  ),
);

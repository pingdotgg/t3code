import * as Detective from "@/AWS/Detective";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class DetectiveTestFunction extends Lambda.Function<Lambda.Function>()(
  "DetectiveTestFunction",
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

// One binding per Detective capability. Write/member/org-admin operations
// with irreversible or cross-account side effects (UpdateDatasourcePackages
// enables billed ingest; CreateMembers invites foreign accounts;
// Enable/DisableOrganizationAdminAccount require the org management
// account) are bound — proving init + IAM deploy — but not exercised
// against live state.
export default DetectiveTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The behavior graph every graph-scoped binding is bound to. Detective
    // allows one graph per account/region — the test account keeps none
    // deployed between runs (Graph.test.ts is capture-and-restore safe).
    const graph = yield* Detective.Graph("BindingsGraph", {
      tags: { fixture: "detective-bindings" },
    });

    // Investigations
    const startInvestigation = yield* Detective.StartInvestigation(graph);
    const getInvestigation = yield* Detective.GetInvestigation(graph);
    const listInvestigations = yield* Detective.ListInvestigations(graph);
    const listIndicators = yield* Detective.ListIndicators(graph);
    const updateInvestigationState =
      yield* Detective.UpdateInvestigationState(graph);

    // Data source packages
    const listDatasourcePackages =
      yield* Detective.ListDatasourcePackages(graph);
    const updateDatasourcePackages =
      yield* Detective.UpdateDatasourcePackages(graph);
    const batchGetGraphMemberDatasources =
      yield* Detective.BatchGetGraphMemberDatasources(graph);

    // Member administration
    const listMembers = yield* Detective.ListMembers(graph);
    const getMembers = yield* Detective.GetMembers(graph);
    const createMembers = yield* Detective.CreateMembers(graph);
    const deleteMembers = yield* Detective.DeleteMembers(graph);
    const startMonitoringMember = yield* Detective.StartMonitoringMember(graph);

    // Member-account invitation flow (account-level)
    const listInvitations = yield* Detective.ListInvitations();
    const acceptInvitation = yield* Detective.AcceptInvitation();
    const rejectInvitation = yield* Detective.RejectInvitation();
    const disassociateMembership = yield* Detective.DisassociateMembership();
    const batchGetMembershipDatasources =
      yield* Detective.BatchGetMembershipDatasources();

    // Organization administration
    const describeOrganizationConfiguration =
      yield* Detective.DescribeOrganizationConfiguration(graph);
    const updateOrganizationConfiguration =
      yield* Detective.UpdateOrganizationConfiguration(graph);
    const listOrganizationAdminAccounts =
      yield* Detective.ListOrganizationAdminAccounts();
    const enableOrganizationAdminAccount =
      yield* Detective.EnableOrganizationAdminAccount();
    const disableOrganizationAdminAccount =
      yield* Detective.DisableOrganizationAdminAccount();

    const bound = {
      startInvestigation,
      getInvestigation,
      listInvestigations,
      listIndicators,
      updateInvestigationState,
      listDatasourcePackages,
      updateDatasourcePackages,
      batchGetGraphMemberDatasources,
      listMembers,
      getMembers,
      createMembers,
      deleteMembers,
      startMonitoringMember,
      listInvitations,
      acceptInvitation,
      rejectInvitation,
      disassociateMembership,
      batchGetMembershipDatasources,
      describeOrganizationConfiguration,
      updateOrganizationConfiguration,
      listOrganizationAdminAccounts,
      enableOrganizationAdminAccount,
      disableOrganizationAdminAccount,
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

        // Graph-scoped reads — the GraphArn is injected from the binding.
        if (request.method === "GET" && pathname === "/members") {
          const { MemberDetails } = yield* listMembers();
          return yield* HttpServerResponse.json({
            count: (MemberDetails ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/member-status") {
          // A well-formed account id that is not a member: Detective
          // answers via UnprocessedAccounts (no side effects).
          const { MemberDetails, UnprocessedAccounts } = yield* getMembers({
            AccountIds: [url.searchParams.get("account") ?? "123456789012"],
          });
          return yield* HttpServerResponse.json({
            members: (MemberDetails ?? []).length,
            unprocessed: (UnprocessedAccounts ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/datasources") {
          const { DatasourcePackages } = yield* listDatasourcePackages();
          return yield* HttpServerResponse.json({
            packages: Object.keys(DatasourcePackages ?? {}),
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/graph-member-datasources"
        ) {
          const result = yield* errorTagged(
            batchGetGraphMemberDatasources({
              AccountIds: [url.searchParams.get("account") ?? "123456789012"],
            }).pipe(
              Effect.map((r) => ({
                memberDatasources: (r.MemberDatasources ?? []).length,
                unprocessed: (r.UnprocessedAccounts ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/investigations") {
          const { InvestigationDetails } = yield* listInvestigations();
          return yield* HttpServerResponse.json({
            count: (InvestigationDetails ?? []).length,
          });
        }

        // Investigation write: a brand-new graph has no ingested data yet,
        // so Detective typically rejects the entity with a typed
        // ValidationException — either outcome proves the binding.
        if (request.method === "POST" && pathname === "/investigate") {
          const entity = url.searchParams.get("entity");
          if (!entity) {
            return yield* HttpServerResponse.json(
              { error: "missing entity" },
              { status: 400 },
            );
          }
          const result = yield* errorTagged(
            startInvestigation({
              EntityArn: entity,
              ScopeStartTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
              ScopeEndTime: new Date(),
            }).pipe(
              Effect.map((r) => ({ investigationId: r.InvestigationId })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Account-level reads (member-account side of the handshake).
        if (request.method === "GET" && pathname === "/invitations") {
          const { Invitations } = yield* listInvitations();
          return yield* HttpServerResponse.json({
            count: (Invitations ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/membership-datasources"
        ) {
          const graphArn = url.searchParams.get("graphArn");
          if (!graphArn) {
            return yield* HttpServerResponse.json(
              { error: "missing graphArn" },
              { status: 400 },
            );
          }
          const result = yield* errorTagged(
            batchGetMembershipDatasources({ GraphArns: [graphArn] }).pipe(
              Effect.map((r) => ({
                membershipDatasources: (r.MembershipDatasources ?? []).length,
                unprocessedGraphs: (r.UnprocessedGraphs ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Org administration: this account is a standalone (non-delegated)
        // account, so Detective answers with a typed error — asserting the
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
                administrators: (r.Administrators ?? []).length,
              })),
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
        Detective.AcceptInvitationHttp,
        Detective.BatchGetGraphMemberDatasourcesHttp,
        Detective.BatchGetMembershipDatasourcesHttp,
        Detective.CreateMembersHttp,
        Detective.DeleteMembersHttp,
        Detective.DescribeOrganizationConfigurationHttp,
        Detective.DisableOrganizationAdminAccountHttp,
        Detective.DisassociateMembershipHttp,
        Detective.EnableOrganizationAdminAccountHttp,
        Detective.GetInvestigationHttp,
        Detective.GetMembersHttp,
        Detective.ListDatasourcePackagesHttp,
        Detective.ListIndicatorsHttp,
        Detective.ListInvestigationsHttp,
        Detective.ListInvitationsHttp,
        Detective.ListMembersHttp,
        Detective.ListOrganizationAdminAccountsHttp,
        Detective.RejectInvitationHttp,
        Detective.StartInvestigationHttp,
        Detective.StartMonitoringMemberHttp,
        Detective.UpdateDatasourcePackagesHttp,
        Detective.UpdateInvestigationStateHttp,
        Detective.UpdateOrganizationConfigurationHttp,
      ),
    ),
  ),
);

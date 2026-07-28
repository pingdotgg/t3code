import * as FMS from "@/AWS/FMS";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class FMSTestFunction extends Lambda.Function<Lambda.Function>()(
  "FMSTestFunction",
) {}

// The testing organization is deliberately NOT onboarded to Firewall Manager
// (see AdminAccount.test.ts — onboarding blocks offboarding for >10 minutes),
// so most routes below prove the binding + IAM grant by observing the exact
// typed not-an-FMS-admin rejection instead of data:
//   - admin-scoped ops (ListPolicies, ListResourceSets, ListMemberAccounts,
//     GetNotificationChannel, ListAppsLists, ListProtocolsLists) reject with
//     `AccessDeniedException: No default admin could be found for account …`
//   - `ListAdminAccountsForOrganization` (management-account-only) rejects
//     with `InvalidOperationException: No default admin could be found for
//     organization …`
//   - `ListAdminsManagingAccount` rejects with `ResourceNotFoundException:
//     The referenced item does not exist.` when the org has no FMS admins
// (all verified by live probe). A genuine IAM gap would surface as an
// UNCAUGHT AccessDeniedException with an "not authorized to perform" message
// on the admin-management routes, which never catch it — and on an FMS-
// onboarded account every route returns Ok data unchanged.
export default FMSTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // --- policies ---
    const getPolicy = yield* FMS.GetPolicy();
    const listPolicies = yield* FMS.ListPolicies();
    const putPolicy = yield* FMS.PutPolicy();
    const deletePolicy = yield* FMS.DeletePolicy();

    // --- applications lists ---
    const getAppsList = yield* FMS.GetAppsList();
    const listAppsLists = yield* FMS.ListAppsLists();
    const putAppsList = yield* FMS.PutAppsList();
    const deleteAppsList = yield* FMS.DeleteAppsList();

    // --- protocols lists ---
    const getProtocolsList = yield* FMS.GetProtocolsList();
    const listProtocolsLists = yield* FMS.ListProtocolsLists();
    const putProtocolsList = yield* FMS.PutProtocolsList();
    const deleteProtocolsList = yield* FMS.DeleteProtocolsList();

    // --- resource sets ---
    const getResourceSet = yield* FMS.GetResourceSet();
    const listResourceSets = yield* FMS.ListResourceSets();
    const putResourceSet = yield* FMS.PutResourceSet();
    const deleteResourceSet = yield* FMS.DeleteResourceSet();
    const listResourceSetResources = yield* FMS.ListResourceSetResources();
    const batchAssociateResource = yield* FMS.BatchAssociateResource();
    const batchDisassociateResource = yield* FMS.BatchDisassociateResource();
    const listDiscoveredResources = yield* FMS.ListDiscoveredResources();

    // --- compliance and protection status ---
    const getComplianceDetail = yield* FMS.GetComplianceDetail();
    const listComplianceStatus = yield* FMS.ListComplianceStatus();
    const getProtectionStatus = yield* FMS.GetProtectionStatus();
    const getViolationDetails = yield* FMS.GetViolationDetails();
    const listMemberAccounts = yield* FMS.ListMemberAccounts();

    // --- notification channel ---
    const getNotificationChannel = yield* FMS.GetNotificationChannel();
    const putNotificationChannel = yield* FMS.PutNotificationChannel();
    const deleteNotificationChannel = yield* FMS.DeleteNotificationChannel();

    // --- administrator management (pinned to us-east-1) ---
    const getAdminScope = yield* FMS.GetAdminScope();
    const listAdminAccountsForOrganization =
      yield* FMS.ListAdminAccountsForOrganization();
    const listAdminsManagingAccount = yield* FMS.ListAdminsManagingAccount();

    // --- third-party firewalls (marketplace-subscription gated) ---
    const associateThirdPartyFirewall =
      yield* FMS.AssociateThirdPartyFirewall();
    const disassociateThirdPartyFirewall =
      yield* FMS.DisassociateThirdPartyFirewall();
    const getThirdPartyFirewallAssociationStatus =
      yield* FMS.GetThirdPartyFirewallAssociationStatus();
    const listThirdPartyFirewallFirewallPolicies =
      yield* FMS.ListThirdPartyFirewallFirewallPolicies();

    const bound = {
      getPolicy,
      listPolicies,
      putPolicy,
      deletePolicy,
      getAppsList,
      listAppsLists,
      putAppsList,
      deleteAppsList,
      getProtocolsList,
      listProtocolsLists,
      putProtocolsList,
      deleteProtocolsList,
      getResourceSet,
      listResourceSets,
      putResourceSet,
      deleteResourceSet,
      listResourceSetResources,
      batchAssociateResource,
      batchDisassociateResource,
      listDiscoveredResources,
      getComplianceDetail,
      listComplianceStatus,
      getProtectionStatus,
      getViolationDetails,
      listMemberAccounts,
      getNotificationChannel,
      putNotificationChannel,
      deleteNotificationChannel,
      getAdminScope,
      listAdminAccountsForOrganization,
      listAdminsManagingAccount,
      associateThirdPartyFirewall,
      disassociateThirdPartyFirewall,
      getThirdPartyFirewallAssociationStatus,
      listThirdPartyFirewallFirewallPolicies,
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

        if (
          request.method === "GET" &&
          pathname === "/admins-managing-account"
        ) {
          const result = yield* listAdminsManagingAccount().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.AdminAccounts ?? []).length,
            })),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/admin-accounts-for-organization"
        ) {
          const result = yield* listAdminAccountsForOrganization().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.AdminAccounts ?? []).length,
            })),
            Effect.catchTag(
              ["InvalidOperationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/policies") {
          const result = yield* listPolicies().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.PolicyList ?? []).length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "InvalidOperationException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/resource-sets") {
          const result = yield* listResourceSets().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.ResourceSets ?? []).length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "InvalidOperationException"],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/member-accounts") {
          const result = yield* listMemberAccounts().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.MemberAccounts ?? []).length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/notification-channel") {
          const result = yield* getNotificationChannel().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              topicArn: r.SnsTopicArn ?? null,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "InvalidOperationException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ tag: e._tag, topicArn: null }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/apps-lists") {
          const result = yield* listAppsLists({ MaxResults: 10 }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.AppsLists ?? []).length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "InvalidOperationException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/protocols-lists") {
          const result = yield* listProtocolsLists({ MaxResults: 10 }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.ProtocolsLists ?? []).length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "InvalidOperationException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/third-party-firewall-status"
        ) {
          const result = yield* getThirdPartyFirewallAssociationStatus({
            ThirdPartyFirewall: "PALO_ALTO_NETWORKS_CLOUD_NGFW",
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              status: r.ThirdPartyFirewallStatus ?? null,
              marketplaceStatus: r.MarketplaceOnboardingStatus ?? null,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "InvalidOperationException",
                "InvalidInputException",
                "ResourceNotFoundException",
              ],
              (e) =>
                Effect.succeed({
                  tag: e._tag,
                  status: null,
                  marketplaceStatus: null,
                }),
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
        Lambda.EventSource,
        FMS.GetPolicyHttp,
        FMS.ListPoliciesHttp,
        FMS.PutPolicyHttp,
        FMS.DeletePolicyHttp,
        FMS.GetAppsListHttp,
        FMS.ListAppsListsHttp,
        FMS.PutAppsListHttp,
        FMS.DeleteAppsListHttp,
        FMS.GetProtocolsListHttp,
        FMS.ListProtocolsListsHttp,
        FMS.PutProtocolsListHttp,
        FMS.DeleteProtocolsListHttp,
        FMS.GetResourceSetHttp,
        FMS.ListResourceSetsHttp,
        FMS.PutResourceSetHttp,
        FMS.DeleteResourceSetHttp,
        FMS.ListResourceSetResourcesHttp,
        FMS.BatchAssociateResourceHttp,
        FMS.BatchDisassociateResourceHttp,
        FMS.ListDiscoveredResourcesHttp,
        FMS.GetComplianceDetailHttp,
        FMS.ListComplianceStatusHttp,
        FMS.GetProtectionStatusHttp,
        FMS.GetViolationDetailsHttp,
        FMS.ListMemberAccountsHttp,
        FMS.GetNotificationChannelHttp,
        FMS.PutNotificationChannelHttp,
        FMS.DeleteNotificationChannelHttp,
        FMS.GetAdminScopeHttp,
        FMS.ListAdminAccountsForOrganizationHttp,
        FMS.ListAdminsManagingAccountHttp,
        FMS.AssociateThirdPartyFirewallHttp,
        FMS.DisassociateThirdPartyFirewallHttp,
        FMS.GetThirdPartyFirewallAssociationStatusHttp,
        FMS.ListThirdPartyFirewallFirewallPoliciesHttp,
      ),
    ),
  ),
);

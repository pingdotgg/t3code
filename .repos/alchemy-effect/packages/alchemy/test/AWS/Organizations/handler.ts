import * as Lambda from "@/AWS/Lambda";
import * as Organizations from "@/AWS/Organizations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent handshake id — drives the typed error paths
// for the handshake bindings (proving the IAM grant + typed union; an IAM gap
// would surface AccessDeniedException instead).
const NONEXISTENT_HANDSHAKE_ID = "h-abcd1234efgh5678";

// A well-formed-but-nonexistent create-account request id.
const NONEXISTENT_CAR_ID = "car-abcd1234abcd1234abcd1234abcd1234";

export class OrganizationsTestFunction extends Lambda.Function<Lambda.Function>()(
  "OrganizationsTestFunction",
) {}

export default OrganizationsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // --- account-level bindings (Organizations is a management-account
    // singleton; these are the organization-tree, policy, delegation,
    // vending, and handshake APIs an org-automation function uses) ---
    const describeOrganization = yield* Organizations.DescribeOrganization();
    const listRoots = yield* Organizations.ListRoots();
    const listAccounts = yield* Organizations.ListAccounts();
    const listAccountsForParent = yield* Organizations.ListAccountsForParent();
    const listOrganizationalUnitsForParent =
      yield* Organizations.ListOrganizationalUnitsForParent();
    const listChildren = yield* Organizations.ListChildren();
    const listParents = yield* Organizations.ListParents();
    const listPolicies = yield* Organizations.ListPolicies();
    const listPoliciesForTarget = yield* Organizations.ListPoliciesForTarget();
    const listTargetsForPolicy = yield* Organizations.ListTargetsForPolicy();
    const describeEffectivePolicy =
      yield* Organizations.DescribeEffectivePolicy();
    const listAccountsWithInvalidEffectivePolicy =
      yield* Organizations.ListAccountsWithInvalidEffectivePolicy();
    const listEffectivePolicyValidationErrors =
      yield* Organizations.ListEffectivePolicyValidationErrors();
    const listDelegatedAdministrators =
      yield* Organizations.ListDelegatedAdministrators();
    const listDelegatedServicesForAccount =
      yield* Organizations.ListDelegatedServicesForAccount();
    const listAWSServiceAccessForOrganization =
      yield* Organizations.ListAWSServiceAccessForOrganization();
    const listTagsForResource = yield* Organizations.ListTagsForResource();
    const describeCreateAccountStatus =
      yield* Organizations.DescribeCreateAccountStatus();
    const listCreateAccountStatus =
      yield* Organizations.ListCreateAccountStatus();
    const inviteAccountToOrganization =
      yield* Organizations.InviteAccountToOrganization();
    const acceptHandshake = yield* Organizations.AcceptHandshake();
    const declineHandshake = yield* Organizations.DeclineHandshake();
    const cancelHandshake = yield* Organizations.CancelHandshake();
    const describeHandshake = yield* Organizations.DescribeHandshake();
    const listHandshakesForAccount =
      yield* Organizations.ListHandshakesForAccount();
    const listHandshakesForOrganization =
      yield* Organizations.ListHandshakesForOrganization();

    // --- event source ---
    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.organizations) targeting this Function. Runtime firing needs a
    // real organization change in us-east-1 of the management account, so
    // the test only verifies the subscription deploys.
    yield* Organizations.consumeOrganizationsEvents(
      { events: ["CreateAccountResult", "MoveAccount"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`organizations event: ${event.detail.eventName}`),
        ),
    );

    const bound = {
      describeOrganization,
      listRoots,
      listAccounts,
      listAccountsForParent,
      listOrganizationalUnitsForParent,
      listChildren,
      listParents,
      listPolicies,
      listPoliciesForTarget,
      listTargetsForPolicy,
      describeEffectivePolicy,
      listAccountsWithInvalidEffectivePolicy,
      listEffectivePolicyValidationErrors,
      listDelegatedAdministrators,
      listDelegatedServicesForAccount,
      listAWSServiceAccessForOrganization,
      listTagsForResource,
      describeCreateAccountStatus,
      listCreateAccountStatus,
      inviteAccountToOrganization,
      acceptHandshake,
      declineHandshake,
      cancelHandshake,
      describeHandshake,
      listHandshakesForAccount,
      listHandshakesForOrganization,
    };

    // The testing account is the management account of a standing
    // organization, so the read paths return live data; every route still
    // tolerates the typed not-in-organization / access-denied tags so the
    // fixture stays correct on any account.
    const rootId = describeOrganization().pipe(
      Effect.flatMap(() => listRoots()),
      Effect.map((r) => r.Roots?.[0]?.Id),
    );

    const managementAccountId = describeOrganization().pipe(
      Effect.map((r) => r.Organization?.MasterAccountId),
    );

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

        if (request.method === "GET" && pathname === "/organization") {
          const result = yield* describeOrganization().pipe(
            Effect.map((r) => ({
              ok: true as const,
              id: r.Organization?.Id ?? null,
              managementAccountId: r.Organization?.MasterAccountId ?? null,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "AWSOrganizationsNotInUseException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/roots") {
          const result = yield* listRoots().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.Roots?.length ?? 0,
              rootId: r.Roots?.[0]?.Id ?? null,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "AWSOrganizationsNotInUseException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/accounts") {
          const result = yield* listAccounts().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.Accounts?.length ?? 0,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "AWSOrganizationsNotInUseException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/accounts-for-parent") {
          const result = yield* Effect.gen(function* () {
            const parent = yield* rootId;
            if (parent === undefined) {
              return { ok: false as const, tag: "NoRoot" };
            }
            const r = yield* listAccountsForParent({ ParentId: parent });
            return { ok: true as const, count: r.Accounts?.length ?? 0 };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ParentNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/ous-for-parent") {
          const result = yield* Effect.gen(function* () {
            const parent = yield* rootId;
            if (parent === undefined) {
              return { ok: false as const, tag: "NoRoot" };
            }
            const r = yield* listOrganizationalUnitsForParent({
              ParentId: parent,
            });
            return {
              ok: true as const,
              count: r.OrganizationalUnits?.length ?? 0,
            };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ParentNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/children") {
          const result = yield* Effect.gen(function* () {
            const parent = yield* rootId;
            if (parent === undefined) {
              return { ok: false as const, tag: "NoRoot" };
            }
            const r = yield* listChildren({
              ParentId: parent,
              ChildType: "ACCOUNT",
            });
            return { ok: true as const, count: r.Children?.length ?? 0 };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ParentNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/parents") {
          const result = yield* Effect.gen(function* () {
            const accountId = yield* managementAccountId;
            if (accountId === undefined) {
              return { ok: false as const, tag: "NoOrganization" };
            }
            const r = yield* listParents({ ChildId: accountId });
            return { ok: true as const, count: r.Parents?.length ?? 0 };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ChildNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/policies") {
          const result = yield* listPolicies({
            Filter: "SERVICE_CONTROL_POLICY",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.Policies?.length ?? 0,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "AWSOrganizationsNotInUseException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/policies-for-target") {
          const result = yield* Effect.gen(function* () {
            const target = yield* rootId;
            if (target === undefined) {
              return { ok: false as const, tag: "NoRoot" };
            }
            const r = yield* listPoliciesForTarget({
              TargetId: target,
              Filter: "SERVICE_CONTROL_POLICY",
            });
            return { ok: true as const, count: r.Policies?.length ?? 0 };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "TargetNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/targets-for-policy") {
          // Discover a policy id from the SCP list (p-FullAWSAccess exists in
          // every organization with SCPs available), then read its targets —
          // proves ListTargetsForPolicy's grant end-to-end.
          const result = yield* Effect.gen(function* () {
            const r = yield* listPolicies({
              Filter: "SERVICE_CONTROL_POLICY",
            });
            const policyId = r.Policies?.[0]?.Id;
            if (policyId === undefined) {
              return { ok: false as const, tag: "NoPolicy" };
            }
            const t = yield* listTargetsForPolicy({ PolicyId: policyId });
            return { ok: true as const, count: t.Targets?.length ?? 0 };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "PolicyNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/effective-policy") {
          // The standing organization has no tag policies enabled, so the
          // grant is proved by the typed EffectivePolicyNotFoundException /
          // ConstraintViolationException rather than live content.
          const result = yield* describeEffectivePolicy({
            PolicyType: "TAG_POLICY",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              policyType: r.EffectivePolicy?.PolicyType ?? null,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ConstraintViolationException",
                "EffectivePolicyNotFoundException",
                "TargetNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/invalid-effective-policy-accounts"
        ) {
          const result = yield* listAccountsWithInvalidEffectivePolicy({
            PolicyType: "TAG_POLICY",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.Accounts?.length ?? 0,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ConstraintViolationException",
                "EffectivePolicyNotFoundException",
                "InvalidInputException",
                "UnsupportedAPIEndpointException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/effective-policy-validation-errors"
        ) {
          const result = yield* Effect.gen(function* () {
            const accountId = yield* managementAccountId;
            if (accountId === undefined) {
              return { ok: false as const, tag: "NoOrganization" };
            }
            const r = yield* listEffectivePolicyValidationErrors({
              AccountId: accountId,
              PolicyType: "TAG_POLICY",
            });
            return {
              ok: true as const,
              count: r.EffectivePolicyValidationErrors?.length ?? 0,
            };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AccountNotFoundException",
                "AWSOrganizationsNotInUseException",
                "ConstraintViolationException",
                "EffectivePolicyNotFoundException",
                "InvalidInputException",
                "UnsupportedAPIEndpointException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/delegated-administrators"
        ) {
          const result = yield* listDelegatedAdministrators().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.DelegatedAdministrators?.length ?? 0,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ConstraintViolationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/delegated-services") {
          // The management account is never a delegated administrator, so
          // the typed AccountNotRegisteredException proves the grant.
          const result = yield* Effect.gen(function* () {
            const accountId = yield* managementAccountId;
            if (accountId === undefined) {
              return { ok: false as const, tag: "NoOrganization" };
            }
            const r = yield* listDelegatedServicesForAccount({
              AccountId: accountId,
            });
            return {
              ok: true as const,
              count: r.DelegatedServices?.length ?? 0,
            };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AccountNotFoundException",
                "AccountNotRegisteredException",
                "AWSOrganizationsNotInUseException",
                "ConstraintViolationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/service-access") {
          const result = yield* listAWSServiceAccessForOrganization().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.EnabledServicePrincipals?.length ?? 0,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ConstraintViolationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/tags") {
          const result = yield* Effect.gen(function* () {
            const accountId = yield* managementAccountId;
            if (accountId === undefined) {
              return { ok: false as const, tag: "NoOrganization" };
            }
            const r = yield* listTagsForResource({ ResourceId: accountId });
            return { ok: true as const, count: r.Tags?.length ?? 0 };
          }).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "TargetNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/create-account-statuses"
        ) {
          const result = yield* listCreateAccountStatus().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.CreateAccountStatuses?.length ?? 0,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "UnsupportedAPIEndpointException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/create-account-status-not-found"
        ) {
          const tag = yield* describeCreateAccountStatus({
            CreateAccountRequestId: NONEXISTENT_CAR_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "CreateAccountStatusNotFoundException",
                "InvalidInputException",
                "UnsupportedAPIEndpointException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/handshakes-account") {
          const result = yield* listHandshakesForAccount().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.Handshakes?.length ?? 0,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ConcurrentModificationException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/handshakes-org") {
          const result = yield* listHandshakesForOrganization().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.Handshakes?.length ?? 0,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ConcurrentModificationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/handshake-not-found") {
          const tag = yield* describeHandshake({
            HandshakeId: NONEXISTENT_HANDSHAKE_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "HandshakeNotFoundException",
                "InvalidInputException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/accept-handshake-not-found"
        ) {
          const tag = yield* acceptHandshake({
            HandshakeId: NONEXISTENT_HANDSHAKE_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "HandshakeNotFoundException",
                "InvalidInputException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/decline-handshake-not-found"
        ) {
          const tag = yield* declineHandshake({
            HandshakeId: NONEXISTENT_HANDSHAKE_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "HandshakeNotFoundException",
                "InvalidInputException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/cancel-handshake-not-found"
        ) {
          const tag = yield* cancelHandshake({
            HandshakeId: NONEXISTENT_HANDSHAKE_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "HandshakeNotFoundException",
                "InvalidInputException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/invite-invalid") {
          // A syntactically invalid target id — proves the grant via the
          // typed InvalidInputException without ever creating a real
          // handshake.
          const tag = yield* inviteAccountToOrganization({
            Target: { Id: "not-a-valid-account-id", Type: "ACCOUNT" },
          }).pipe(
            Effect.map(() => "Invited"),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "AWSOrganizationsNotInUseException",
                "ConstraintViolationException",
                "HandshakeConstraintViolationException",
                "InvalidInputException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
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
        Organizations.DescribeOrganizationHttp,
        Organizations.ListRootsHttp,
        Organizations.ListAccountsHttp,
        Organizations.ListAccountsForParentHttp,
        Organizations.ListOrganizationalUnitsForParentHttp,
        Organizations.ListChildrenHttp,
        Organizations.ListParentsHttp,
        Organizations.ListPoliciesHttp,
        Organizations.ListPoliciesForTargetHttp,
        Organizations.ListTargetsForPolicyHttp,
        Organizations.DescribeEffectivePolicyHttp,
        Organizations.ListAccountsWithInvalidEffectivePolicyHttp,
        Organizations.ListEffectivePolicyValidationErrorsHttp,
        Organizations.ListDelegatedAdministratorsHttp,
        Organizations.ListDelegatedServicesForAccountHttp,
        Organizations.ListAWSServiceAccessForOrganizationHttp,
        Organizations.ListTagsForResourceHttp,
        Organizations.DescribeCreateAccountStatusHttp,
        Organizations.ListCreateAccountStatusHttp,
        Organizations.InviteAccountToOrganizationHttp,
        Organizations.AcceptHandshakeHttp,
        Organizations.DeclineHandshakeHttp,
        Organizations.CancelHandshakeHttp,
        Organizations.DescribeHandshakeHttp,
        Organizations.ListHandshakesForAccountHttp,
        Organizations.ListHandshakesForOrganizationHttp,
      ),
    ),
  ),
);

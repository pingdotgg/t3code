import * as Lambda from "@/AWS/Lambda";
import * as Macie2 from "@/AWS/Macie2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class Macie2TestFunction extends Lambda.Function<Lambda.Function>()(
  "Macie2TestFunction",
) {}

/**
 * Routes answer `{ …fields }` on success or `{ errorTag }` when the operation
 * fails with a TYPED error — the test asserts the tag is in a route-specific
 * allowlist, which proves both the binding wiring and the IAM grant. An
 * untyped error crashes into a 500 instead.
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

// One binding per exercised Macie capability. Every Macie2 binding shares the
// single account-level scaffolding shape (the request passes through as-is),
// so a representative spread across the thematic groups proves the scaffold;
// org/member writes with cross-account side effects (CreateMember,
// EnableOrganizationAdminAccount, …) use the same builder and are not
// re-proven here.
export default Macie2TestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Macie must be enabled for every runtime call — the session is the
    // account/region singleton the whole fixture leans on. The Bindings test
    // only runs when the account had no session (capture-and-restore safety).
    yield* Macie2.Session("BindingsSession", {
      status: "ENABLED",
      findingPublishingFrequency: "FIFTEEN_MINUTES",
    });

    // Findings triage loop
    const createSampleFindings = yield* Macie2.CreateSampleFindings();
    const listFindings = yield* Macie2.ListFindings();
    const getFindings = yield* Macie2.GetFindings();
    const getFindingStatistics = yield* Macie2.GetFindingStatistics();

    // S3 bucket inventory
    const getBucketStatistics = yield* Macie2.GetBucketStatistics();
    const searchResources = yield* Macie2.SearchResources();

    // Identifiers & lists
    const listManagedDataIdentifiers =
      yield* Macie2.ListManagedDataIdentifiers();
    const testCustomDataIdentifier = yield* Macie2.TestCustomDataIdentifier();
    const listAllowLists = yield* Macie2.ListAllowLists();
    const listFindingsFilters = yield* Macie2.ListFindingsFilters();

    // Jobs, export & usage
    const listClassificationJobs = yield* Macie2.ListClassificationJobs();
    const getClassificationExportConfiguration =
      yield* Macie2.GetClassificationExportConfiguration();
    const getUsageTotals = yield* Macie2.GetUsageTotals();

    // Automated discovery & reveal
    const getAutomatedDiscoveryConfiguration =
      yield* Macie2.GetAutomatedDiscoveryConfiguration();
    const listClassificationScopes = yield* Macie2.ListClassificationScopes();
    const getRevealConfiguration = yield* Macie2.GetRevealConfiguration();

    // Administrator, invitations & organization
    const getAdministratorAccount = yield* Macie2.GetAdministratorAccount();
    const getInvitationsCount = yield* Macie2.GetInvitationsCount();
    const listInvitations = yield* Macie2.ListInvitations();
    const listMembers = yield* Macie2.ListMembers();
    const listOrganizationAdminAccounts =
      yield* Macie2.ListOrganizationAdminAccounts();
    const describeOrganizationConfiguration =
      yield* Macie2.DescribeOrganizationConfiguration();

    const bound = {
      createSampleFindings,
      listFindings,
      getFindings,
      getFindingStatistics,
      getBucketStatistics,
      searchResources,
      listManagedDataIdentifiers,
      testCustomDataIdentifier,
      listAllowLists,
      listFindingsFilters,
      listClassificationJobs,
      getClassificationExportConfiguration,
      getUsageTotals,
      getAutomatedDiscoveryConfiguration,
      listClassificationScopes,
      getRevealConfiguration,
      getAdministratorAccount,
      getInvitationsCount,
      listInvitations,
      listMembers,
      listOrganizationAdminAccounts,
      describeOrganizationConfiguration,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // Generates sample findings — the documented way to exercise a
        // findings pipeline without staging real sensitive data.
        if (request.method === "POST" && pathname === "/sample") {
          yield* createSampleFindings({});
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/findings") {
          const { findingIds } = yield* listFindings();
          return yield* HttpServerResponse.json({
            count: (findingIds ?? []).length,
            ids: (findingIds ?? []).slice(0, 5),
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
          const { findings } = yield* getFindings({ findingIds: [id] });
          return yield* HttpServerResponse.json({
            count: (findings ?? []).length,
            type: findings?.[0]?.type,
            sample: findings?.[0]?.sample ?? false,
          });
        }

        if (request.method === "GET" && pathname === "/finding-stats") {
          const { countsByGroup } = yield* getFindingStatistics({
            groupBy: "severity.description",
          });
          return yield* HttpServerResponse.json({
            groups: (countsByGroup ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/buckets") {
          const stats = yield* getBucketStatistics({});
          return yield* HttpServerResponse.json({
            bucketCount: Number(stats.bucketCount ?? 0),
          });
        }

        if (request.method === "GET" && pathname === "/search") {
          // SearchResources requires bucket criteria — exclude a bucket that
          // cannot exist, i.e. match everything.
          const { matchingResources } = yield* searchResources({
            bucketCriteria: {
              excludes: {
                and: [
                  {
                    simpleCriterion: {
                      comparator: "EQ",
                      key: "S3_BUCKET_NAME",
                      values: ["macie2-bindings-nonexistent-bucket"],
                    },
                  },
                ],
              },
            },
          });
          return yield* HttpServerResponse.json({
            matches: (matchingResources ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/managed-identifiers") {
          const { items } = yield* listManagedDataIdentifiers();
          return yield* HttpServerResponse.json({
            count: (items ?? []).length,
          });
        }

        // A real detection round-trip that needs no cloud state at all.
        if (request.method === "POST" && pathname === "/test-identifier") {
          const { matchCount } = yield* testCustomDataIdentifier({
            regex: "EMP-[0-9]{8}",
            sampleText: "ids EMP-12345678 and EMP-87654321 but not EMP-123",
          });
          return yield* HttpServerResponse.json({ matchCount });
        }

        if (request.method === "GET" && pathname === "/allow-lists") {
          const { allowLists } = yield* listAllowLists();
          return yield* HttpServerResponse.json({
            count: (allowLists ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/findings-filters") {
          const { findingsFilterListItems } = yield* listFindingsFilters();
          return yield* HttpServerResponse.json({
            count: (findingsFilterListItems ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const { items } = yield* listClassificationJobs();
          return yield* HttpServerResponse.json({
            count: (items ?? []).length,
          });
        }

        // A fresh session has no export configuration — an empty document.
        if (request.method === "GET" && pathname === "/export-config") {
          const { configuration } =
            yield* getClassificationExportConfiguration();
          return yield* HttpServerResponse.json({
            configured: configuration?.s3Destination !== undefined,
          });
        }

        if (request.method === "GET" && pathname === "/usage") {
          const { usageTotals } = yield* getUsageTotals();
          return yield* HttpServerResponse.json({
            totals: (usageTotals ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/auto-discovery") {
          const { status } = yield* getAutomatedDiscoveryConfiguration();
          return yield* HttpServerResponse.json({ status: status ?? null });
        }

        if (request.method === "GET" && pathname === "/scopes") {
          const { classificationScopes } = yield* listClassificationScopes();
          return yield* HttpServerResponse.json({
            count: (classificationScopes ?? []).length,
          });
        }

        // A fresh session rejects the reveal-configuration read with a typed
        // AccessDeniedException until sample retrieval is set up.
        if (request.method === "GET" && pathname === "/reveal") {
          const result = yield* errorTagged(
            getRevealConfiguration().pipe(
              Effect.map((r) => ({
                status: r.configuration?.status ?? null,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // A standalone account has no administrator — Macie answers with an
        // empty document or a typed error.
        if (request.method === "GET" && pathname === "/admin") {
          const result = yield* errorTagged(
            getAdministratorAccount().pipe(
              Effect.map((r) => ({
                administrator: r.administrator?.accountId ?? null,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/invitations-count") {
          const { invitationsCount } = yield* getInvitationsCount();
          return yield* HttpServerResponse.json({
            count: Number(invitationsCount ?? 0),
          });
        }

        if (request.method === "GET" && pathname === "/invitations") {
          const { invitations } = yield* listInvitations();
          return yield* HttpServerResponse.json({
            count: (invitations ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/members") {
          const { members } = yield* listMembers();
          return yield* HttpServerResponse.json({
            count: (members ?? []).length,
          });
        }

        // Organization administration: for a standalone (non-management)
        // account Macie answers with a typed error — asserting the tag proves
        // the binding + IAM wiring end-to-end.
        if (request.method === "GET" && pathname === "/org-admins") {
          const result = yield* errorTagged(
            listOrganizationAdminAccounts().pipe(
              Effect.map((r) => ({ admins: (r.adminAccounts ?? []).length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/org-config") {
          const result = yield* errorTagged(
            describeOrganizationConfiguration().pipe(
              Effect.map((r) => ({ autoEnable: r.autoEnable ?? false })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface typed operation errors as JSON so live-test failures carry
        // the tag + message instead of an opaque 500 (routes that expect a
        // typed error use `errorTagged` above and never reach this).
        Effect.catch((e) =>
          HttpServerResponse.json(
            {
              errorTag: (e as { _tag?: string })._tag ?? "UnknownError",
              errorMessage:
                (e as { message?: string }).message ??
                (e as { Message?: string }).Message,
            },
            { status: 500 },
          ),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Macie2.CreateSampleFindingsHttp,
        Macie2.DescribeOrganizationConfigurationHttp,
        Macie2.GetAdministratorAccountHttp,
        Macie2.GetAutomatedDiscoveryConfigurationHttp,
        Macie2.GetBucketStatisticsHttp,
        Macie2.GetClassificationExportConfigurationHttp,
        Macie2.GetFindingStatisticsHttp,
        Macie2.GetFindingsHttp,
        Macie2.GetInvitationsCountHttp,
        Macie2.GetRevealConfigurationHttp,
        Macie2.GetUsageTotalsHttp,
        Macie2.ListAllowListsHttp,
        Macie2.ListClassificationJobsHttp,
        Macie2.ListClassificationScopesHttp,
        Macie2.ListFindingsFiltersHttp,
        Macie2.ListFindingsHttp,
        Macie2.ListInvitationsHttp,
        Macie2.ListManagedDataIdentifiersHttp,
        Macie2.ListMembersHttp,
        Macie2.ListOrganizationAdminAccountsHttp,
        Macie2.SearchResourcesHttp,
        Macie2.TestCustomDataIdentifierHttp,
      ),
    ),
  ),
);

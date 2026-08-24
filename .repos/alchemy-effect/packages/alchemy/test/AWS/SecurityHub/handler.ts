import * as Lambda from "@/AWS/Lambda";
import * as SecurityHub from "@/AWS/SecurityHub";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class SecurityHubTestFunction extends Lambda.Function<Lambda.Function>()(
  "SecurityHubTestFunction",
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

// One binding per exercised Security Hub capability. Every SecurityHub
// binding shares the single account-level scaffolding shape (the request
// passes through as-is), so a representative spread across the thematic
// groups proves the scaffold; org/member writes with cross-account side
// effects (CreateMembers, EnableOrganizationAdminAccount, …) use the same
// builder and are not re-proven here.
export default SecurityHubTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Security Hub must be enabled for every runtime call — the Hub is the
    // account/region singleton the whole fixture leans on. The Bindings test
    // only runs when the account had no Hub (capture-and-restore safety).
    yield* SecurityHub.Hub("BindingsHub", { enableDefaultStandards: false });

    // Findings triage loop
    const getFindings = yield* SecurityHub.GetFindings();
    const getFindingHistory = yield* SecurityHub.GetFindingHistory();
    const batchImportFindings = yield* SecurityHub.BatchImportFindings();
    const batchUpdateFindings = yield* SecurityHub.BatchUpdateFindings();

    // Insights
    const getInsights = yield* SecurityHub.GetInsights();

    // Standards & controls
    const describeStandards = yield* SecurityHub.DescribeStandards();
    const getEnabledStandards = yield* SecurityHub.GetEnabledStandards();
    const listSecurityControlDefinitions =
      yield* SecurityHub.ListSecurityControlDefinitions();
    const getSecurityControlDefinition =
      yield* SecurityHub.GetSecurityControlDefinition();

    // Product integrations
    const describeProducts = yield* SecurityHub.DescribeProducts();
    const listEnabledProductsForImport =
      yield* SecurityHub.ListEnabledProductsForImport();

    // Custom actions, automation rules & aggregation reads
    const describeActionTargets = yield* SecurityHub.DescribeActionTargets();
    const listAutomationRules = yield* SecurityHub.ListAutomationRules();
    const listFindingAggregators = yield* SecurityHub.ListFindingAggregators();

    // Members & organization
    const listMembers = yield* SecurityHub.ListMembers();
    const listInvitations = yield* SecurityHub.ListInvitations();
    const getInvitationsCount = yield* SecurityHub.GetInvitationsCount();
    const getAdministratorAccount =
      yield* SecurityHub.GetAdministratorAccount();
    const listOrganizationAdminAccounts =
      yield* SecurityHub.ListOrganizationAdminAccounts();
    const describeOrganizationConfiguration =
      yield* SecurityHub.DescribeOrganizationConfiguration();

    const bound = {
      getFindings,
      getFindingHistory,
      batchImportFindings,
      batchUpdateFindings,
      getInsights,
      describeStandards,
      getEnabledStandards,
      listSecurityControlDefinitions,
      getSecurityControlDefinition,
      describeProducts,
      listEnabledProductsForImport,
      describeActionTargets,
      listAutomationRules,
      listFindingAggregators,
      listMembers,
      listInvitations,
      getInvitationsCount,
      getAdministratorAccount,
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

        // Imports a synthetic ASFF finding through the account's default
        // product — the documented way to exercise a findings pipeline. The
        // test computes id/account/region out-of-band and passes them in.
        if (request.method === "POST" && pathname === "/import") {
          const id = url.searchParams.get("id");
          const accountId = url.searchParams.get("account");
          const region = url.searchParams.get("region");
          if (!id || !accountId || !region) {
            return yield* HttpServerResponse.json(
              { error: "missing id/account/region" },
              { status: 400 },
            );
          }
          const productArn = `arn:aws:securityhub:${region}:${accountId}:product/${accountId}/default`;
          const now = new Date().toISOString();
          const result = yield* batchImportFindings({
            Findings: [
              {
                SchemaVersion: "2018-10-08",
                Id: id,
                ProductArn: productArn,
                GeneratorId: "alchemy-bindings-test",
                AwsAccountId: accountId,
                Types: ["Software and Configuration Checks"],
                CreatedAt: now,
                UpdatedAt: now,
                Severity: { Label: "INFORMATIONAL" },
                Title: "Alchemy SecurityHub bindings test finding",
                Description:
                  "Synthetic finding imported by the alchemy SecurityHub bindings test.",
                Resources: [
                  {
                    Type: "Other",
                    Id: "alchemy-bindings-test-resource",
                    Partition: "aws",
                    Region: region,
                  },
                ],
              },
            ],
          });
          return yield* HttpServerResponse.json({
            success: Number(result.SuccessCount ?? 0),
            failed: Number(result.FailedCount ?? 0),
          });
        }

        if (request.method === "GET" && pathname === "/findings") {
          const id = url.searchParams.get("id");
          const { Findings } = yield* getFindings({
            ...(id
              ? { Filters: { Id: [{ Value: id, Comparison: "EQUALS" }] } }
              : { MaxResults: 10 }),
          });
          return yield* HttpServerResponse.json({
            count: (Findings ?? []).length,
            workflow: Findings?.[0]?.Workflow?.Status,
            title: Findings?.[0]?.Title,
          });
        }

        // Updates customer-editable fields on the imported finding.
        if (request.method === "POST" && pathname === "/resolve") {
          const id = url.searchParams.get("id");
          const productArn = url.searchParams.get("productArn");
          if (!id || !productArn) {
            return yield* HttpServerResponse.json(
              { error: "missing id/productArn" },
              { status: 400 },
            );
          }
          const result = yield* batchUpdateFindings({
            FindingIdentifiers: [{ Id: id, ProductArn: productArn }],
            Workflow: { Status: "NOTIFIED" },
            Note: {
              Text: "acknowledged by the alchemy bindings test",
              UpdatedBy: "alchemy",
            },
          });
          return yield* HttpServerResponse.json({
            processed: (result.ProcessedFindings ?? []).length,
            unprocessed: (result.UnprocessedFindings ?? []).length,
          });
        }

        // Finding history may lag the import — a typed ResourceNotFound is an
        // acceptable outcome that still proves the binding + IAM wiring.
        if (request.method === "GET" && pathname === "/history") {
          const id = url.searchParams.get("id");
          const productArn = url.searchParams.get("productArn");
          if (!id || !productArn) {
            return yield* HttpServerResponse.json(
              { error: "missing id/productArn" },
              { status: 400 },
            );
          }
          const result = yield* errorTagged(
            getFindingHistory({
              FindingIdentifier: { Id: id, ProductArn: productArn },
            }).pipe(Effect.map((r) => ({ records: (r.Records ?? []).length }))),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/insights") {
          const { Insights } = yield* getInsights();
          return yield* HttpServerResponse.json({
            count: (Insights ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/standards") {
          const { Standards } = yield* describeStandards();
          return yield* HttpServerResponse.json({
            count: (Standards ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/enabled-standards") {
          const { StandardsSubscriptions } = yield* getEnabledStandards();
          return yield* HttpServerResponse.json({
            count: (StandardsSubscriptions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/control-definitions") {
          const { SecurityControlDefinitions } =
            yield* listSecurityControlDefinitions({ MaxResults: 10 });
          return yield* HttpServerResponse.json({
            count: (SecurityControlDefinitions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/control") {
          const { SecurityControlDefinition } =
            yield* getSecurityControlDefinition({
              SecurityControlId: "IAM.1",
            });
          return yield* HttpServerResponse.json({
            id: SecurityControlDefinition?.SecurityControlId ?? null,
            severity: SecurityControlDefinition?.SeverityRating ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/products") {
          const { Products } = yield* describeProducts({ MaxResults: 10 });
          return yield* HttpServerResponse.json({
            count: (Products ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/enabled-products") {
          const { ProductSubscriptions } =
            yield* listEnabledProductsForImport();
          return yield* HttpServerResponse.json({
            count: (ProductSubscriptions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/action-targets") {
          const { ActionTargets } = yield* describeActionTargets();
          return yield* HttpServerResponse.json({
            count: (ActionTargets ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/automation-rules") {
          const { AutomationRulesMetadata } = yield* listAutomationRules();
          return yield* HttpServerResponse.json({
            count: (AutomationRulesMetadata ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/aggregators") {
          const { FindingAggregators } = yield* listFindingAggregators();
          return yield* HttpServerResponse.json({
            count: (FindingAggregators ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/members") {
          const { Members } = yield* listMembers();
          return yield* HttpServerResponse.json({
            count: (Members ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/invitations") {
          const { Invitations } = yield* listInvitations();
          return yield* HttpServerResponse.json({
            count: (Invitations ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/invitations-count") {
          const { InvitationsCount } = yield* getInvitationsCount();
          return yield* HttpServerResponse.json({
            count: Number(InvitationsCount ?? 0),
          });
        }

        // A standalone account has no administrator — Security Hub answers
        // with an empty document or a typed error.
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

        // Organization administration: for a standalone (non-management)
        // account Security Hub answers with a typed error — asserting the tag
        // proves the binding + IAM wiring end-to-end.
        if (request.method === "GET" && pathname === "/org-admins") {
          const result = yield* errorTagged(
            listOrganizationAdminAccounts().pipe(
              Effect.map((r) => ({ admins: (r.AdminAccounts ?? []).length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/org-config") {
          const result = yield* errorTagged(
            describeOrganizationConfiguration().pipe(
              Effect.map((r) => ({ autoEnable: r.AutoEnable ?? false })),
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
        SecurityHub.BatchImportFindingsHttp,
        SecurityHub.BatchUpdateFindingsHttp,
        SecurityHub.DescribeActionTargetsHttp,
        SecurityHub.DescribeOrganizationConfigurationHttp,
        SecurityHub.DescribeProductsHttp,
        SecurityHub.DescribeStandardsHttp,
        SecurityHub.GetAdministratorAccountHttp,
        SecurityHub.GetEnabledStandardsHttp,
        SecurityHub.GetFindingHistoryHttp,
        SecurityHub.GetFindingsHttp,
        SecurityHub.GetInsightsHttp,
        SecurityHub.GetInvitationsCountHttp,
        SecurityHub.GetSecurityControlDefinitionHttp,
        SecurityHub.ListAutomationRulesHttp,
        SecurityHub.ListEnabledProductsForImportHttp,
        SecurityHub.ListFindingAggregatorsHttp,
        SecurityHub.ListInvitationsHttp,
        SecurityHub.ListMembersHttp,
        SecurityHub.ListOrganizationAdminAccountsHttp,
        SecurityHub.ListSecurityControlDefinitionsHttp,
      ),
    ),
  ),
);

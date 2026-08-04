import * as Grafana from "@/AWS/Grafana";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "workspace-handler.ts");

export class GrafanaWorkspaceTestFunction extends Lambda.Function<Lambda.Function>()(
  "GrafanaWorkspaceTestFunction",
) {}

/** Unwrap a possibly-redacted secret returned by the distilled client. */
const unwrap = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

/**
 * GATED fixture (AWS_TEST_GRAFANA=1): creates a SAML-authenticated Grafana
 * workspace (no IAM Identity Center requirement) and binds every
 * workspace-scoped capability. License and mutation-heavy capabilities
 * (AssociateLicense enables billed Enterprise; UpdateWorkspaceAuthentication
 * and UpdateWorkspaceConfiguration mutate long-lived workspace state;
 * UpdatePermissions requires SSO users) are bound — proving init + IAM
 * deploy — but not exercised against live state.
 */
export default GrafanaWorkspaceTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const workspace = yield* Grafana.Workspace("BindingsWorkspace", {
      description: "grafana bindings fixture",
      accountAccessType: "CURRENT_ACCOUNT",
      authenticationProviders: ["SAML"],
      permissionType: "SERVICE_MANAGED",
      dataSources: ["CLOUDWATCH"],
      tags: { fixture: "grafana-bindings" },
    });

    const describeAuth =
      yield* Grafana.DescribeWorkspaceAuthentication(workspace);
    const updateAuth = yield* Grafana.UpdateWorkspaceAuthentication(workspace);
    const describeConfig =
      yield* Grafana.DescribeWorkspaceConfiguration(workspace);
    const updateConfig = yield* Grafana.UpdateWorkspaceConfiguration(workspace);
    const associateLicense = yield* Grafana.AssociateLicense(workspace);
    const disassociateLicense = yield* Grafana.DisassociateLicense(workspace);
    const listPermissions = yield* Grafana.ListPermissions(workspace);
    const updatePermissions = yield* Grafana.UpdatePermissions(workspace);
    const createServiceAccount =
      yield* Grafana.CreateWorkspaceServiceAccount(workspace);
    const deleteServiceAccount =
      yield* Grafana.DeleteWorkspaceServiceAccount(workspace);
    const listServiceAccounts =
      yield* Grafana.ListWorkspaceServiceAccounts(workspace);
    const createToken =
      yield* Grafana.CreateWorkspaceServiceAccountToken(workspace);
    const deleteToken =
      yield* Grafana.DeleteWorkspaceServiceAccountToken(workspace);
    const listTokens =
      yield* Grafana.ListWorkspaceServiceAccountTokens(workspace);
    const listVersions = yield* Grafana.ListVersions();

    const bound = {
      describeAuth,
      updateAuth,
      describeConfig,
      updateConfig,
      associateLicense,
      disassociateLicense,
      listPermissions,
      updatePermissions,
      createServiceAccount,
      deleteServiceAccount,
      listServiceAccounts,
      createToken,
      deleteToken,
      listTokens,
      listVersions,
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

        // Injected workspace id: the auth description round-trips.
        if (request.method === "GET" && pathname === "/auth") {
          const { authentication } = yield* describeAuth();
          return yield* HttpServerResponse.json({
            providers: authentication.providers,
            samlStatus: authentication.saml?.status,
          });
        }

        if (request.method === "GET" && pathname === "/config") {
          const { configuration, grafanaVersion } = yield* describeConfig();
          return yield* HttpServerResponse.json({
            hasConfiguration: configuration.length > 0,
            grafanaVersion,
          });
        }

        // A SAML-only workspace may reject SSO-permission listing with a
        // typed error — either outcome proves the binding + IAM wiring.
        if (request.method === "GET" && pathname === "/permissions") {
          const result = yield* errorTagged(
            listPermissions().pipe(
              Effect.map((r) => ({ count: r.permissions.length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/service-accounts") {
          const { serviceAccounts } = yield* listServiceAccounts();
          return yield* HttpServerResponse.json({
            count: serviceAccounts.length,
          });
        }

        // Upgradable versions for the bound workspace (account-level cap).
        if (request.method === "GET" && pathname === "/versions") {
          const { grafanaVersions } = yield* listVersions();
          return yield* HttpServerResponse.json({
            count: (grafanaVersions ?? []).length,
          });
        }

        // Full service-account + token lifecycle: create → mint (Duration
        // timeToLive → wire secondsToLive; Redacted key) → list → revoke →
        // delete. Exercises five bindings in one deterministic round-trip.
        if (
          request.method === "POST" &&
          pathname === "/service-account-roundtrip"
        ) {
          const account = yield* createServiceAccount({
            name: "bindings-roundtrip",
            grafanaRole: "EDITOR",
          });

          const minted = yield* createToken({
            name: "bindings-roundtrip-token",
            serviceAccountId: account.id,
            timeToLive: "5 minutes",
          });
          const key = unwrap(minted.serviceAccountToken.key);

          const { serviceAccountTokens } = yield* listTokens({
            serviceAccountId: account.id,
          });

          yield* deleteToken({
            serviceAccountId: account.id,
            tokenId: minted.serviceAccountToken.id,
          });
          yield* deleteServiceAccount({ serviceAccountId: account.id });

          return yield* HttpServerResponse.json({
            serviceAccountId: account.id,
            grafanaRole: account.grafanaRole,
            keyPrefix: key.slice(0, 5),
            keyLength: key.length,
            tokenCount: serviceAccountTokens.length,
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
        Grafana.AssociateLicenseHttp,
        Grafana.CreateWorkspaceServiceAccountHttp,
        Grafana.CreateWorkspaceServiceAccountTokenHttp,
        Grafana.DeleteWorkspaceServiceAccountHttp,
        Grafana.DeleteWorkspaceServiceAccountTokenHttp,
        Grafana.DescribeWorkspaceAuthenticationHttp,
        Grafana.DescribeWorkspaceConfigurationHttp,
        Grafana.DisassociateLicenseHttp,
        Grafana.ListPermissionsHttp,
        Grafana.ListVersionsHttp,
        Grafana.ListWorkspaceServiceAccountsHttp,
        Grafana.ListWorkspaceServiceAccountTokensHttp,
        Grafana.UpdatePermissionsHttp,
        Grafana.UpdateWorkspaceAuthenticationHttp,
        Grafana.UpdateWorkspaceConfigurationHttp,
      ),
    ),
  ),
);

import * as LicenseManager from "@/AWS/LicenseManager";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed-but-nonexistent identifiers — drive the typed error paths,
// proving the account-level grants reach the API (an IAM gap would surface
// AccessDeniedException and 500 the route instead).
const BOGUS_LICENSE_ARN =
  "arn:aws:license-manager::111111111111:license:l-00000000000000000000000000000000";
const BOGUS_GRANT_ARN =
  "arn:aws:license-manager::111111111111:grant:g-00000000000000000000000000000000";
const BOGUS_RESOURCE_ARN = "arn:aws:ec2:us-east-1::image/ami-00000000000000000";

export class LicenseManagerTestFunction extends Lambda.Function<Lambda.Function>()(
  "LicenseManagerTestFunction",
) {}

export default LicenseManagerTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const licenses = yield* LicenseManager.LicenseConfiguration(
      "BindingsLicenses",
      {
        licenseCountingType: "vCPU",
        licenseCount: 5,
        description: "alchemy license-manager bindings fixture",
      },
    );

    // --- configuration-scoped bindings ---
    const getConfiguration =
      yield* LicenseManager.GetLicenseConfiguration(licenses);
    const listAssociations =
      yield* LicenseManager.ListAssociationsForLicenseConfiguration(licenses);
    const listUsage =
      yield* LicenseManager.ListUsageForLicenseConfiguration(licenses);
    const listFailures =
      yield* LicenseManager.ListFailuresForLicenseConfigurationOperations(
        licenses,
      );

    // --- checkout data plane (account-level) ---
    const checkoutLicense = yield* LicenseManager.CheckoutLicense();
    const checkInLicense = yield* LicenseManager.CheckInLicense();
    const checkoutBorrowLicense = yield* LicenseManager.CheckoutBorrowLicense();
    const extendLicenseConsumption =
      yield* LicenseManager.ExtendLicenseConsumption();
    const getAccessToken = yield* LicenseManager.GetAccessToken();

    // --- license/grant reads (account-level) ---
    const getLicense = yield* LicenseManager.GetLicense();
    const getLicenseUsage = yield* LicenseManager.GetLicenseUsage();
    const listLicenses = yield* LicenseManager.ListLicenses();
    const listLicenseVersions = yield* LicenseManager.ListLicenseVersions();
    const listReceivedLicenses = yield* LicenseManager.ListReceivedLicenses();
    const getGrant = yield* LicenseManager.GetGrant();
    const acceptGrant = yield* LicenseManager.AcceptGrant();
    const rejectGrant = yield* LicenseManager.RejectGrant();
    const listReceivedGrants = yield* LicenseManager.ListReceivedGrants();
    const listDistributedGrants = yield* LicenseManager.ListDistributedGrants();

    // --- inventory + specifications + settings (account-level) ---
    const listResourceInventory = yield* LicenseManager.ListResourceInventory();
    const listLicenseSpecificationsForResource =
      yield* LicenseManager.ListLicenseSpecificationsForResource();
    const updateLicenseSpecificationsForResource =
      yield* LicenseManager.UpdateLicenseSpecificationsForResource();
    const getServiceSettings = yield* LicenseManager.GetServiceSettings();

    const bound = {
      getConfiguration,
      listAssociations,
      listUsage,
      listFailures,
      checkoutLicense,
      checkInLicense,
      checkoutBorrowLicense,
      extendLicenseConsumption,
      getAccessToken,
      getLicense,
      getLicenseUsage,
      listLicenses,
      listLicenseVersions,
      listReceivedLicenses,
      getGrant,
      acceptGrant,
      rejectGrant,
      listReceivedGrants,
      listDistributedGrants,
      listResourceInventory,
      listLicenseSpecificationsForResource,
      updateLicenseSpecificationsForResource,
      getServiceSettings,
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

        if (request.method === "GET" && pathname === "/configuration") {
          const config = yield* getConfiguration();
          return yield* HttpServerResponse.json({
            name: config.Name ?? null,
            countingType: config.LicenseCountingType ?? null,
            licenseCount: config.LicenseCount ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/associations") {
          const result = yield* listAssociations();
          return yield* HttpServerResponse.json({
            count: (result.LicenseConfigurationAssociations ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/usage") {
          const result = yield* listUsage();
          return yield* HttpServerResponse.json({
            count: (result.LicenseConfigurationUsageList ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/failures") {
          const result = yield* listFailures();
          return yield* HttpServerResponse.json({
            count: (result.LicenseOperationFailureList ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/licenses") {
          const result = yield* listLicenses();
          return yield* HttpServerResponse.json({
            count: (result.Licenses ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/received-licenses") {
          const result = yield* listReceivedLicenses();
          return yield* HttpServerResponse.json({
            count: (result.Licenses ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/received-grants") {
          const result = yield* listReceivedGrants();
          return yield* HttpServerResponse.json({
            count: (result.Grants ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/distributed-grants") {
          const result = yield* listDistributedGrants();
          return yield* HttpServerResponse.json({
            count: (result.Grants ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/inventory") {
          // Resource inventory requires Systems Manager inventory; an account
          // without it rejects with the typed FailedDependencyException —
          // either outcome proves the binding + grant.
          const result = yield* listResourceInventory().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.ResourceInventoryList ?? []).length,
            })),
            Effect.catchTag("FailedDependencyException", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/service-settings") {
          const result = yield* getServiceSettings();
          return yield* HttpServerResponse.json({
            tag: "Ok",
            hasSnsTopic: result.SnsTopicArn !== undefined,
          });
        }

        if (request.method === "GET" && pathname === "/checkout-invalid") {
          // A nonexistent product SKU must surface a typed rejection — a
          // genuine IAM gap surfaces AccessDeniedException and 500s instead.
          const result = yield* checkoutLicense({
            ProductSKU: "00000000-0000-0000-0000-000000000000",
            CheckoutType: "PROVISIONAL",
            KeyFingerprint: "aws:294406891311:AWS/KeyManagement:v1",
            Entitlements: [{ Name: "seats", Value: "1", Unit: "Count" }],
            ClientToken: "00000000-0000-4000-8000-000000000000",
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "NoEntitlementsAllowedException",
                "InvalidParameterValueException",
                "ValidationException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (request.method === "GET" && pathname === "/access-token-invalid") {
          // A malformed refresh token must surface a typed rejection —
          // "Invalid token." arrives as InvalidParameterValueException
          // (verified by probe; patched into distilled's GetAccessToken
          // union, which the Smithy model omits).
          const result = yield* getAccessToken({
            Token: "not-a-valid-refresh-token",
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "InvalidParameterValueException",
                "ValidationException",
                "AuthorizationException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (request.method === "GET" && pathname === "/license-invalid") {
          const result = yield* getLicense({
            LicenseArn: BOGUS_LICENSE_ARN,
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterValueException",
                "ValidationException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (request.method === "GET" && pathname === "/grant-invalid") {
          const result = yield* getGrant({ GrantArn: BOGUS_GRANT_ARN }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterValueException",
                "ValidationException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (
          request.method === "GET" &&
          pathname === "/specifications-invalid"
        ) {
          const result = yield* listLicenseSpecificationsForResource({
            ResourceArn: BOGUS_RESOURCE_ARN,
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.LicenseSpecifications ?? []).length,
            })),
            Effect.catchTag("InvalidParameterValueException", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
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
        LicenseManager.GetLicenseConfigurationHttp,
        LicenseManager.ListAssociationsForLicenseConfigurationHttp,
        LicenseManager.ListUsageForLicenseConfigurationHttp,
        LicenseManager.ListFailuresForLicenseConfigurationOperationsHttp,
        LicenseManager.CheckoutLicenseHttp,
        LicenseManager.CheckInLicenseHttp,
        LicenseManager.CheckoutBorrowLicenseHttp,
        LicenseManager.ExtendLicenseConsumptionHttp,
        LicenseManager.GetAccessTokenHttp,
        LicenseManager.GetLicenseHttp,
        LicenseManager.GetLicenseUsageHttp,
        LicenseManager.ListLicensesHttp,
        LicenseManager.ListLicenseVersionsHttp,
        LicenseManager.ListReceivedLicensesHttp,
        LicenseManager.GetGrantHttp,
        LicenseManager.AcceptGrantHttp,
        LicenseManager.RejectGrantHttp,
        LicenseManager.ListReceivedGrantsHttp,
        LicenseManager.ListDistributedGrantsHttp,
        LicenseManager.ListResourceInventoryHttp,
        LicenseManager.ListLicenseSpecificationsForResourceHttp,
        LicenseManager.UpdateLicenseSpecificationsForResourceHttp,
        LicenseManager.GetServiceSettingsHttp,
      ),
    ),
  ),
);

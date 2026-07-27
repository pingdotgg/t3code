import * as LicenseManager from "@/AWS/LicenseManager";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { randomUUID } from "node:crypto";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "seller-handler.ts");

// Deterministic fixture identifiers — the lifecycle route sweeps stale
// licenses left by a crashed prior run before issuing a fresh one.
const FIXTURE_LICENSE_NAME = "alchemy-lm-seller-e2e";
const FIXTURE_PRODUCT_SKU = "alchemy-lm-seller-sku";
const FIXTURE_PRODUCT_NAME = "Alchemy LicenseManager Fixture";

// Well-formed-but-nonexistent grant — drives the typed error path of
// CreateGrantVersion (a genuine IAM gap would 500 with AccessDenied).
const BOGUS_GRANT_ARN =
  "arn:aws:license-manager::111111111111:grant:g-00000000000000000000000000000000";

export class LicenseManagerSellerFunction extends Lambda.Function<Lambda.Function>()(
  "LicenseManagerSellerFunction",
) {}

export default LicenseManagerSellerFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // --- seller-issued license / grant / token data plane (account-level) ---
    const createLicense = yield* LicenseManager.CreateLicense();
    const createLicenseVersion = yield* LicenseManager.CreateLicenseVersion();
    const deleteLicense = yield* LicenseManager.DeleteLicense();
    const createGrant = yield* LicenseManager.CreateGrant();
    const createGrantVersion = yield* LicenseManager.CreateGrantVersion();
    const deleteGrant = yield* LicenseManager.DeleteGrant();
    const createToken = yield* LicenseManager.CreateToken();
    const deleteToken = yield* LicenseManager.DeleteToken();
    const listTokens = yield* LicenseManager.ListTokens();

    // --- consumer half of the loop (already-covered bindings, re-used here
    //     to drive the seller-issued license end-to-end) ---
    const getLicense = yield* LicenseManager.GetLicense();
    const listLicenses = yield* LicenseManager.ListLicenses();
    const getAccessToken = yield* LicenseManager.GetAccessToken();
    const checkoutLicense = yield* LicenseManager.CheckoutLicense();
    const extendLicenseConsumption =
      yield* LicenseManager.ExtendLicenseConsumption();
    const checkInLicense = yield* LicenseManager.CheckInLicense();

    const bound = {
      createLicense,
      createLicenseVersion,
      deleteLicense,
      createGrant,
      createGrantVersion,
      deleteGrant,
      createToken,
      deleteToken,
      listTokens,
    };

    const uuid = Effect.sync(() => randomUUID());

    // Delete a seller license, tolerating the typed rejections a stale or
    // already-deleted ARN surfaces.
    const deleteLicenseQuietly = (arn: string, version: string) =>
      deleteLicense({ LicenseArn: arn, SourceVersion: version }).pipe(
        Effect.map(() => undefined),
        Effect.catchTag(
          ["InvalidParameterValueException", "ConflictException"],
          () => Effect.succeed(undefined),
        ),
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

        // Full seller data plane: issue -> version -> token mint/exchange ->
        // checkout/extend/checkin -> grant create/delete -> delete.
        if (request.method === "POST" && pathname === "/lifecycle") {
          const beneficiary = url.searchParams.get("account");
          if (beneficiary === null) {
            return yield* HttpServerResponse.json(
              { error: "missing ?account=" },
              { status: 400 },
            );
          }
          const region = yield* Effect.sync(() => process.env.AWS_REGION!);
          const now = yield* Effect.sync(() => Date.now());
          const begin = new Date(now - 24 * 3600 * 1000).toISOString();
          const end = new Date(now + 365 * 24 * 3600 * 1000).toISOString();
          const bumpedEnd = new Date(
            now + 2 * 365 * 24 * 3600 * 1000,
          ).toISOString();
          const entitlements = [
            {
              Name: "seats",
              MaxCount: 10,
              Unit: "Count",
              AllowCheckIn: true,
              Overage: false,
            },
          ];
          const consumption = {
            RenewType: "None",
            ProvisionalConfiguration: { MaxTimeToLiveInMinutes: 60 },
          };

          // Zero-orphan: sweep stale fixture licenses from crashed runs.
          const stale = yield* listLicenses();
          yield* Effect.forEach(
            (stale.Licenses ?? []).filter(
              (l): boolean =>
                l.LicenseName === FIXTURE_LICENSE_NAME &&
                l.Status === "AVAILABLE" &&
                l.LicenseArn !== undefined &&
                l.Version !== undefined,
            ),
            (l) => deleteLicenseQuietly(l.LicenseArn!, l.Version!),
          );

          // 1. Issue the license.
          const created = yield* createLicense({
            LicenseName: FIXTURE_LICENSE_NAME,
            ProductName: FIXTURE_PRODUCT_NAME,
            ProductSKU: FIXTURE_PRODUCT_SKU,
            Issuer: { Name: "alchemy" },
            HomeRegion: region,
            Validity: { Begin: begin, End: end },
            Entitlements: entitlements,
            Beneficiary: beneficiary,
            ConsumptionConfiguration: consumption,
            ClientToken: yield* uuid,
          });
          const licenseArn = created.LicenseArn!;

          // 2. Observe until AVAILABLE (bounded), capture issuer fingerprint.
          const { License } = yield* getLicense({
            LicenseArn: licenseArn,
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean => r.License?.Status === "AVAILABLE",
              times: 8,
            }),
          );
          const fingerprint = License!.Issuer!.KeyFingerprint!;

          // 3. Publish a new version (extended validity).
          const bumped = yield* createLicenseVersion({
            LicenseArn: licenseArn,
            LicenseName: FIXTURE_LICENSE_NAME,
            ProductName: FIXTURE_PRODUCT_NAME,
            Issuer: { Name: "alchemy" },
            HomeRegion: region,
            Validity: { Begin: begin, End: bumpedEnd },
            Entitlements: entitlements,
            ConsumptionConfiguration: consumption,
            Status: "AVAILABLE",
            SourceVersion: License!.Version!,
            ClientToken: yield* uuid,
          });
          const version = bumped.Version ?? License!.Version!;

          // 4. Mint an activation token, exchange + revoke it. The exchange
          //    result stays Redacted; only its presence is reported.
          const token = yield* createToken({
            LicenseArn: licenseArn,
            ClientToken: yield* uuid,
          });
          const tokens = yield* listTokens({ TokenIds: [token.TokenId!] });
          const accessToken = yield* getAccessToken({
            Token: token.Token!,
          }).pipe(
            Effect.map((r) => (r.AccessToken !== undefined ? "Ok" : "Empty")),
            Effect.catchTag(
              [
                "AuthorizationException",
                "ValidationException",
                "AccessDeniedException",
                "InvalidParameterValueException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          yield* deleteToken({ TokenId: token.TokenId! });

          // 5. Check out the license as the beneficiary account, extend the
          //    provisional consumption, and check it back in. Retry through
          //    issuance propagation with a bounded typed retry.
          const checkout = yield* checkoutLicense({
            ProductSKU: FIXTURE_PRODUCT_SKU,
            CheckoutType: "PROVISIONAL",
            KeyFingerprint: fingerprint,
            Entitlements: [{ Name: "seats", Value: "1", Unit: "Count" }],
            ClientToken: yield* uuid,
            Beneficiary: beneficiary,
          }).pipe(
            Effect.retry({
              while: (e): boolean =>
                e._tag === "ResourceNotFoundException" ||
                e._tag === "NoEntitlementsAllowedException",
              schedule: Schedule.exponential("1 second"),
              times: 5,
            }),
          );
          const consumptionToken = checkout.LicenseConsumptionToken!;
          const extended = yield* extendLicenseConsumption({
            LicenseConsumptionToken: consumptionToken,
          });
          yield* checkInLicense({
            LicenseConsumptionToken: consumptionToken,
          });

          // 6. Grant lifecycle — a self-account grant may be rejected with a
          //    typed validation error; either outcome proves grant + wiring.
          const grant = yield* createGrant({
            GrantName: "alchemy-lm-seller-grant",
            LicenseArn: licenseArn,
            HomeRegion: region,
            Principals: [`arn:aws:iam::${beneficiary}:root`],
            AllowedOperations: [
              "CheckoutLicense",
              "CheckInLicense",
              "ExtendConsumptionLicense",
              "ListPurchasedLicenses",
            ],
            ClientToken: yield* uuid,
          }).pipe(
            Effect.flatMap((g) =>
              deleteGrant({ GrantArn: g.GrantArn!, Version: g.Version! }).pipe(
                Effect.map(() => "CreatedAndDeleted"),
              ),
            ),
            Effect.catchTag(
              [
                "InvalidParameterValueException",
                "ValidationException",
                "AuthorizationException",
                "ResourceLimitExceededException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );

          // 7. Delete the license (retry through a lingering consumption).
          const deletion = yield* deleteLicense({
            LicenseArn: licenseArn,
            SourceVersion: version,
          }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "ConflictException",
              schedule: Schedule.exponential("1 second"),
              times: 4,
            }),
          );

          return yield* HttpServerResponse.json({
            licenseArn,
            licenseStatus: License?.Status ?? null,
            bumpedVersion: bumped.Version ?? null,
            tokenListed: (tokens.Tokens ?? []).length,
            accessToken,
            checkedOut: checkout.LicenseConsumptionToken !== undefined,
            extended: extended.LicenseConsumptionToken !== undefined,
            grant,
            deletionStatus: deletion.Status ?? null,
          });
        }

        // Typed probe: CreateGrantVersion on a nonexistent grant surfaces a
        // typed rejection (an IAM gap would 500 with AccessDenied instead).
        if (request.method === "GET" && pathname === "/grant-version-invalid") {
          const result = yield* createGrantVersion({
            GrantArn: BOGUS_GRANT_ARN,
            ClientToken: "00000000-0000-4000-8000-000000000001",
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
        LicenseManager.CreateLicenseHttp,
        LicenseManager.CreateLicenseVersionHttp,
        LicenseManager.DeleteLicenseHttp,
        LicenseManager.CreateGrantHttp,
        LicenseManager.CreateGrantVersionHttp,
        LicenseManager.DeleteGrantHttp,
        LicenseManager.CreateTokenHttp,
        LicenseManager.DeleteTokenHttp,
        LicenseManager.ListTokensHttp,
        LicenseManager.GetLicenseHttp,
        LicenseManager.ListLicensesHttp,
        LicenseManager.GetAccessTokenHttp,
        LicenseManager.CheckoutLicenseHttp,
        LicenseManager.ExtendLicenseConsumptionHttp,
        LicenseManager.CheckInLicenseHttp,
      ),
    ),
  ),
);

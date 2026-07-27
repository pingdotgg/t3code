import * as Account from "@/AWS/Account";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// The Account API marks contact fields sensitive at the wire level, so
// distilled returns them as `string | Redacted<string>`. The fixture never
// echoes the PII itself — only presence/shape — so unwrap locally.
const unwrap = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

export class AccountTestFunction extends Lambda.Function<Lambda.Function>()(
  "AccountTestFunction",
) {}

export default AccountTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // --- account-level bindings (Account Management is an account
    // singleton; these are the settings reads an ops/compliance function
    // uses) ---
    const getAccountInformation = yield* Account.GetAccountInformation();
    const getContactInformation = yield* Account.GetContactInformation();
    const getAlternateContact = yield* Account.GetAlternateContact();
    const listRegions = yield* Account.ListRegions();
    const getRegionOptStatus = yield* Account.GetRegionOptStatus();

    const bound = {
      getAccountInformation,
      getContactInformation,
      getAlternateContact,
      listRegions,
      getRegionOptStatus,
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

        if (request.method === "GET" && pathname === "/account-info") {
          const result = yield* getAccountInformation().pipe(
            Effect.map((r) => ({
              ok: true as const,
              accountId: r.AccountId ?? null,
              accountState: r.AccountState ?? null,
              hasAccountName: (unwrap(r.AccountName) ?? "").length > 0,
            })),
            Effect.catchTag("AccessDeniedException", (e) =>
              Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/contact-info") {
          const result = yield* getContactInformation().pipe(
            Effect.map((r) => ({
              ok: true as const,
              hasFullName:
                (unwrap(r.ContactInformation?.FullName) ?? "").length > 0,
              hasCountryCode:
                (unwrap(r.ContactInformation?.CountryCode) ?? "").length > 0,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/alternate-contact") {
          // The BILLING alternate contact may or may not be set on the
          // account — the typed ResourceNotFoundException proves the grant
          // just as well as live data.
          const result = yield* getAlternateContact({
            AlternateContactType: "BILLING",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              contactType: r.AlternateContact?.AlternateContactType ?? null,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/regions") {
          // The default page size (20) cuts the alphabetical list off before
          // us-east-1 — ask for the maximum page.
          const result = yield* listRegions({ MaxResults: 50 }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.Regions?.length ?? 0,
              regionNames: (r.Regions ?? [])
                .map((region) => region.RegionName)
                .filter((name): name is string => name !== undefined),
            })),
            Effect.catchTag("AccessDeniedException", (e) =>
              Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/region-opt-status") {
          // us-east-1 is enabled by default in every account.
          const result = yield* getRegionOptStatus({
            RegionName: "us-east-1",
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              regionName: r.RegionName ?? null,
              regionOptStatus: r.RegionOptStatus ?? null,
            })),
            Effect.catchTag("AccessDeniedException", (e) =>
              Effect.succeed({ ok: false as const, tag: e._tag }),
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
        Account.GetAccountInformationHttp,
        Account.GetContactInformationHttp,
        Account.GetAlternateContactHttp,
        Account.ListRegionsHttp,
        Account.GetRegionOptStatusHttp,
      ),
    ),
  ),
);

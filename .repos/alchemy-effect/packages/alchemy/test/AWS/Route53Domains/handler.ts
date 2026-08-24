import * as Lambda from "@/AWS/Lambda";
import * as Route53Domains from "@/AWS/Route53Domains";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class Route53DomainsTestFunction extends Lambda.Function<Lambda.Function>()(
  "Route53DomainsTestFunction",
) {}

// Serialize a Result into { ok, errorTag } JSON — routes that exercise
// error paths must reach the API (proving the IAM grant and the us-east-1
// pin) and fail with a typed domain-level error, never AccessDenied.
const errorRoute = <A, E extends { _tag: string }>(
  effect: Effect.Effect<A, E>,
  onSuccess: (value: A) => object,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    if (Result.isFailure(result)) {
      return yield* HttpServerResponse.json({
        ok: false,
        errorTag: result.failure._tag,
        errorMessage: String(
          (result.failure as { message?: unknown }).message ?? "",
        ),
      });
    }
    return yield* HttpServerResponse.json({
      ok: true,
      ...onSuccess(result.success),
    });
  });

export default Route53DomainsTestFunction.make(
  {
    main,
    url: true,
    // Route 53 Domains calls cross to us-east-1; give cold starts headroom
    // over the 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const checkDomainAvailability =
      yield* Route53Domains.CheckDomainAvailability();
    const checkDomainTransferability =
      yield* Route53Domains.CheckDomainTransferability();
    const getDomainDetail = yield* Route53Domains.GetDomainDetail();
    const getDomainSuggestions = yield* Route53Domains.GetDomainSuggestions();
    const getOperationDetail = yield* Route53Domains.GetOperationDetail();
    const listDomains = yield* Route53Domains.ListDomains();
    const listOperations = yield* Route53Domains.ListOperations();
    const listPrices = yield* Route53Domains.ListPrices();
    const registerDomain = yield* Route53Domains.RegisterDomain();
    const renewDomain = yield* Route53Domains.RenewDomain();
    const retrieveDomainAuthCode =
      yield* Route53Domains.RetrieveDomainAuthCode();
    const updateDomainNameservers =
      yield* Route53Domains.UpdateDomainNameservers();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Route 53 Domains call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/availability") {
          const result = yield* checkDomainAvailability({
            // Deterministic probe name — availability checks are read-only
            // and free; this suite NEVER registers a domain.
            DomainName: "alchemy-effect-r53d-probe-a32892.com",
          });
          return yield* HttpServerResponse.json({
            availability: result.Availability,
          });
        }

        if (request.method === "GET" && pathname === "/transferability") {
          const result = yield* checkDomainTransferability({
            DomainName: "example.com",
          });
          return yield* HttpServerResponse.json({
            transferable: result.Transferability?.Transferable,
          });
        }

        if (request.method === "GET" && pathname === "/suggestions") {
          const result = yield* getDomainSuggestions({
            DomainName: "example.com",
            SuggestionCount: 5,
            OnlyAvailable: false,
          });
          return yield* HttpServerResponse.json({
            count: (result.SuggestionsList ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/prices") {
          const result = yield* listPrices({ Tld: "com" });
          return yield* HttpServerResponse.json({
            count: (result.Prices ?? []).length,
            registrationPrice: result.Prices?.[0]?.RegistrationPrice?.Price,
          });
        }

        if (request.method === "GET" && pathname === "/operations") {
          const result = yield* listOperations({ MaxItems: 10 });
          return yield* HttpServerResponse.json({
            count: (result.Operations ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/domains") {
          const result = yield* listDomains({ MaxItems: 100 });
          return yield* HttpServerResponse.json({
            count: (result.Domains ?? []).length,
            names: (result.Domains ?? [])
              .map((domain) => domain.DomainName)
              .filter((name) => name !== undefined),
          });
        }

        if (request.method === "GET" && pathname === "/detail") {
          // example.com is never registered in the test account — the call
          // must reach the API (proving the IAM grant and us-east-1 pin)
          // and come back as a typed domain-level error, not AccessDenied.
          return yield* errorRoute(
            getDomainDetail({ DomainName: "example.com" }),
            (detail) => ({ domainName: detail.DomainName }),
          );
        }

        if (request.method === "GET" && pathname === "/operation-detail") {
          // A syntactically valid but non-existent operation id — the call
          // must reach the API and fail with a typed InvalidInput, never
          // AccessDenied.
          return yield* errorRoute(
            getOperationDetail({
              OperationId: "00000000-0000-0000-0000-000000000000",
            }),
            (detail) => ({ status: detail.Status }),
          );
        }

        if (request.method === "GET" && pathname === "/auth-code") {
          // example.com is not in the account — typed domain-level error.
          // On success the AuthCode would be Redacted; this route never
          // returns it.
          return yield* errorRoute(
            retrieveDomainAuthCode({ DomainName: "example.com" }),
            () => ({ hasAuthCode: true }),
          );
        }

        if (request.method === "GET" && pathname === "/nameservers") {
          // example.com is not in the account — typed domain-level error.
          return yield* errorRoute(
            updateDomainNameservers({
              DomainName: "example.com",
              Nameservers: [{ Name: "ns-1.awsdns-01.org" }],
            }),
            (r) => ({ operationId: r.OperationId }),
          );
        }

        if (request.method === "GET" && pathname === "/renew") {
          // example.com is not in the account — typed domain-level error.
          // No renewal is ever billed by this suite.
          return yield* errorRoute(
            renewDomain({
              DomainName: "example.com",
              DurationInYears: 1,
              CurrentExpiryYear: 2030,
            }),
            (r) => ({ operationId: r.OperationId }),
          );
        }

        if (request.method === "GET" && pathname === "/register") {
          // Deliberately unsupported TLD — the request reaches the API and
          // is rejected with a typed error before any registration or
          // billing can occur. This suite NEVER registers a domain.
          return yield* errorRoute(
            registerDomain({
              DomainName: "alchemy-effect-r53d-probe-a32892.invalidtld99",
              DurationInYears: 1,
              AdminContact: {},
              RegistrantContact: {},
              TechContact: {},
            }),
            (r) => ({ operationId: r.OperationId }),
          );
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
        Route53Domains.CheckDomainAvailabilityHttp,
        Route53Domains.CheckDomainTransferabilityHttp,
        Route53Domains.GetDomainDetailHttp,
        Route53Domains.GetDomainSuggestionsHttp,
        Route53Domains.GetOperationDetailHttp,
        Route53Domains.ListDomainsHttp,
        Route53Domains.ListOperationsHttp,
        Route53Domains.ListPricesHttp,
        Route53Domains.RegisterDomainHttp,
        Route53Domains.RenewDomainHttp,
        Route53Domains.RetrieveDomainAuthCodeHttp,
        Route53Domains.UpdateDomainNameserversHttp,
      ),
    ),
  ),
);

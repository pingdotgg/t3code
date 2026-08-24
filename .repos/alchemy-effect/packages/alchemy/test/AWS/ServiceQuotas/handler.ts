import * as Lambda from "@/AWS/Lambda";
import * as ServiceQuotas from "@/AWS/ServiceQuotas";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ServiceQuotasTestFunction extends Lambda.Function<Lambda.Function>()(
  "ServiceQuotasTestFunction",
) {}

export default ServiceQuotasTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const getServiceQuota = yield* ServiceQuotas.GetServiceQuota();
    const getAWSDefaultServiceQuota =
      yield* ServiceQuotas.GetAWSDefaultServiceQuota();
    const listServices = yield* ServiceQuotas.ListServices();
    const listServiceQuotas = yield* ServiceQuotas.ListServiceQuotas();
    const listRequestedServiceQuotaChangeHistoryByQuota =
      yield* ServiceQuotas.ListRequestedServiceQuotaChangeHistoryByQuota();
    const requestServiceQuotaIncrease =
      yield* ServiceQuotas.RequestServiceQuotaIncrease();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Service Quotas call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/quota") {
          const serviceCode = url.searchParams.get("service");
          const quotaCode = url.searchParams.get("quota");
          if (serviceCode === null || quotaCode === null) {
            return yield* HttpServerResponse.json(
              { error: "service and quota query params are required" },
              { status: 400 },
            );
          }
          return yield* getServiceQuota({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                quotaCode: result.Quota?.QuotaCode,
                quotaName: result.Quota?.QuotaName,
                value: result.Quota?.Value,
                adjustable: result.Quota?.Adjustable,
              }),
            ),
            // The typed not-found tag round-trips as a 404 so the test can
            // assert the binding surfaces distilled's typed error union.
            Effect.catchTag("NoSuchResourceException", () =>
              HttpServerResponse.json(
                { tag: "NoSuchResourceException" },
                { status: 404 },
              ),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/default-quota") {
          const serviceCode = url.searchParams.get("service");
          const quotaCode = url.searchParams.get("quota");
          if (serviceCode === null || quotaCode === null) {
            return yield* HttpServerResponse.json(
              { error: "service and quota query params are required" },
              { status: 400 },
            );
          }
          return yield* getAWSDefaultServiceQuota({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                quotaCode: result.Quota?.QuotaCode,
                value: result.Quota?.Value,
              }),
            ),
            Effect.catchTag("NoSuchResourceException", () =>
              HttpServerResponse.json(
                { tag: "NoSuchResourceException" },
                { status: 404 },
              ),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/services") {
          const result = yield* listServices({ MaxResults: 20 });
          return yield* HttpServerResponse.json({
            serviceCodes: (result.Services ?? []).map((s) => s.ServiceCode),
          });
        }

        if (request.method === "GET" && pathname === "/quotas") {
          const serviceCode = url.searchParams.get("service");
          if (serviceCode === null) {
            return yield* HttpServerResponse.json(
              { error: "service query param is required" },
              { status: 400 },
            );
          }
          return yield* listServiceQuotas({
            ServiceCode: serviceCode,
            MaxResults: 20,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                quotaCodes: (result.Quotas ?? []).map((q) => q.QuotaCode),
              }),
            ),
            Effect.catchTag("NoSuchResourceException", () =>
              HttpServerResponse.json(
                { tag: "NoSuchResourceException" },
                { status: 404 },
              ),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/history") {
          const serviceCode = url.searchParams.get("service");
          const quotaCode = url.searchParams.get("quota");
          if (serviceCode === null || quotaCode === null) {
            return yield* HttpServerResponse.json(
              { error: "service and quota query params are required" },
              { status: 400 },
            );
          }
          return yield* listRequestedServiceQuotaChangeHistoryByQuota({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                count: (result.RequestedQuotas ?? []).length,
              }),
            ),
            Effect.catchTag("NoSuchResourceException", () =>
              HttpServerResponse.json(
                { tag: "NoSuchResourceException" },
                { status: 404 },
              ),
            ),
          );
        }

        // Exercises the write-path IAM grant without mutating the account:
        // the bogus quota code fails with the typed NoSuchResourceException
        // BEFORE any request is submitted. An AccessDenied would surface as
        // a 500 (die) instead.
        if (request.method === "POST" && pathname === "/request-increase") {
          const serviceCode = url.searchParams.get("service");
          const quotaCode = url.searchParams.get("quota");
          if (serviceCode === null || quotaCode === null) {
            return yield* HttpServerResponse.json(
              { error: "service and quota query params are required" },
              { status: 400 },
            );
          }
          return yield* requestServiceQuotaIncrease({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
            DesiredValue: 1,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                requestId: result.RequestedQuota?.Id,
                status: result.RequestedQuota?.Status,
              }),
            ),
            Effect.catchTag("NoSuchResourceException", () =>
              HttpServerResponse.json(
                { tag: "NoSuchResourceException" },
                { status: 404 },
              ),
            ),
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
        ServiceQuotas.GetServiceQuotaHttp,
        ServiceQuotas.GetAWSDefaultServiceQuotaHttp,
        ServiceQuotas.ListServicesHttp,
        ServiceQuotas.ListServiceQuotasHttp,
        ServiceQuotas.ListRequestedServiceQuotaChangeHistoryByQuotaHttp,
        ServiceQuotas.RequestServiceQuotaIncreaseHttp,
      ),
    ),
  ),
);

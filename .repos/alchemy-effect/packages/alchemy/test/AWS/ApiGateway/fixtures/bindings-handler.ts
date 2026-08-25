import * as ApiGateway from "@/AWS/ApiGateway";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class ApiGatewayBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "ApiGatewayBindingsFunction",
) {}

export default ApiGatewayBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Usage plan the key-management routes enroll keys into.
    const plan = yield* ApiGateway.UsagePlan("AgBindingsPlan", {
      throttle: { rateLimit: 10, burstLimit: 5 },
    });

    // Minimal REST API + stage so the flush-cache bindings have a target.
    const api = yield* ApiGateway.RestApi("AgBindingsApi", {
      endpointConfiguration: { types: ["REGIONAL"] },
    });
    yield* ApiGateway.Method("AgBindingsMock", {
      restApi: api,
      httpMethod: "GET",
      authorizationType: "NONE",
      integration: { type: "MOCK" },
    });
    const deployment = yield* ApiGateway.Deployment("AgBindingsDep", {
      restApi: api,
    });
    const stage = yield* ApiGateway.Stage("AgBindingsStage", {
      restApi: api,
      stageName: "bindings",
      deploymentId: deployment.deploymentId,
    });

    const createApiKey = yield* ApiGateway.CreateApiKey();
    const getApiKey = yield* ApiGateway.GetApiKey();
    const getApiKeys = yield* ApiGateway.GetApiKeys();
    const updateApiKey = yield* ApiGateway.UpdateApiKey();
    const deleteApiKey = yield* ApiGateway.DeleteApiKey();
    const createUsagePlanKey = yield* ApiGateway.CreateUsagePlanKey(plan);
    const getUsagePlanKey = yield* ApiGateway.GetUsagePlanKey(plan);
    const getUsagePlanKeys = yield* ApiGateway.GetUsagePlanKeys(plan);
    const deleteUsagePlanKey = yield* ApiGateway.DeleteUsagePlanKey(plan);
    const getUsage = yield* ApiGateway.GetUsage(plan);
    const updateUsage = yield* ApiGateway.UpdateUsage(plan);
    const flushStageCache = yield* ApiGateway.FlushStageCache(stage);
    const flushStageAuthorizersCache =
      yield* ApiGateway.FlushStageAuthorizersCache(stage);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/keys") {
          const body = (yield* request.json) as unknown as { name: string };
          const created = yield* createApiKey({
            name: body.name,
            enabled: true,
          });
          yield* createUsagePlanKey({ keyId: created.id! });
          return yield* HttpServerResponse.json({
            id: created.id,
            // Responses decode the key material to Redacted<string> — prove
            // it round-tripped redacted without ever logging the plaintext.
            valueRedacted: Redacted.isRedacted(created.value),
          });
        }

        if (request.method === "GET" && pathname === "/keys") {
          const nameQuery = url.searchParams.get("nameQuery") ?? undefined;
          const page = yield* getApiKeys({ nameQuery, limit: 100 });
          return yield* HttpServerResponse.json({
            ids: (page.items ?? []).map((k) => k.id),
          });
        }

        if (request.method === "GET" && pathname === "/key") {
          const id = url.searchParams.get("id")!;
          const key = yield* getApiKey({ apiKey: id });
          return yield* HttpServerResponse.json({
            id: key.id,
            name: key.name,
            enabled: key.enabled,
          });
        }

        if (request.method === "POST" && pathname === "/disable") {
          const body = (yield* request.json) as unknown as { id: string };
          const key = yield* updateApiKey({
            apiKey: body.id,
            patchOperations: [
              { op: "replace", path: "/enabled", value: "false" },
            ],
          });
          return yield* HttpServerResponse.json({ enabled: key.enabled });
        }

        if (request.method === "GET" && pathname === "/plan-key") {
          const id = url.searchParams.get("id")!;
          const enrolled = yield* getUsagePlanKey({ keyId: id }).pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFoundException", () => Effect.succeed(false)),
          );
          return yield* HttpServerResponse.json({ enrolled });
        }

        if (request.method === "GET" && pathname === "/plan-keys") {
          const page = yield* getUsagePlanKeys({ limit: 100 });
          return yield* HttpServerResponse.json({
            ids: (page.items ?? []).map((k) => k.id),
          });
        }

        if (request.method === "GET" && pathname === "/usage") {
          const keyId = url.searchParams.get("keyId") ?? undefined;
          const startDate = url.searchParams.get("startDate")!;
          const endDate = url.searchParams.get("endDate")!;
          const usage = yield* getUsage({ keyId, startDate, endDate });
          return yield* HttpServerResponse.json({
            usagePlanId: usage.usagePlanId,
            items: usage.items ?? {},
          });
        }

        if (request.method === "POST" && pathname === "/extend") {
          const body = (yield* request.json) as unknown as { keyId: string };
          // Quota extensions only apply to plans with a quota; on this
          // plan the API answers BadRequest — the IAM grant is still
          // exercised (a missing grant surfaces as UnauthorizedException /
          // AccessDenied instead, failing the route).
          const extended = yield* updateUsage({
            keyId: body.keyId,
            patchOperations: [
              { op: "replace", path: "/remaining", value: "100" },
            ],
          }).pipe(
            Effect.map(() => true),
            Effect.catchTag(["BadRequestException", "NotFoundException"], () =>
              Effect.succeed(false),
            ),
          );
          return yield* HttpServerResponse.json({ extended });
        }

        if (request.method === "DELETE" && pathname === "/key") {
          const id = url.searchParams.get("id")!;
          yield* deleteUsagePlanKey({ keyId: id }).pipe(
            Effect.catchTag("NotFoundException", () => Effect.void),
          );
          yield* deleteApiKey({ apiKey: id }).pipe(
            Effect.catchTag("NotFoundException", () => Effect.void),
          );
          return yield* HttpServerResponse.json({ deleted: true });
        }

        if (request.method === "POST" && pathname === "/flush") {
          // The stage has no cache cluster, so API Gateway answers
          // BadRequest/NotFound — the IAM grant is still exercised (a
          // missing grant surfaces as an auth error instead).
          const cache = yield* flushStageCache().pipe(
            Effect.map(() => true),
            Effect.catchTag(["BadRequestException", "NotFoundException"], () =>
              Effect.succeed(false),
            ),
          );
          const authorizers = yield* flushStageAuthorizersCache().pipe(
            Effect.map(() => true),
            Effect.catchTag(["BadRequestException", "NotFoundException"], () =>
              Effect.succeed(false),
            ),
          );
          return yield* HttpServerResponse.json({ cache, authorizers });
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
        ApiGateway.CreateApiKeyHttp,
        ApiGateway.GetApiKeyHttp,
        ApiGateway.GetApiKeysHttp,
        ApiGateway.UpdateApiKeyHttp,
        ApiGateway.DeleteApiKeyHttp,
        ApiGateway.CreateUsagePlanKeyHttp,
        ApiGateway.GetUsagePlanKeyHttp,
        ApiGateway.GetUsagePlanKeysHttp,
        ApiGateway.DeleteUsagePlanKeyHttp,
        ApiGateway.GetUsageHttp,
        ApiGateway.UpdateUsageHttp,
        ApiGateway.FlushStageCacheHttp,
        ApiGateway.FlushStageAuthorizersCacheHttp,
      ),
    ),
  ),
);

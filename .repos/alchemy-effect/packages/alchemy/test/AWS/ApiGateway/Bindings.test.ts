import * as AWS from "@/AWS";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import ApiGatewayBindingsFunctionLive, {
  ApiGatewayBindingsFunction,
} from "./fixtures/bindings-handler.ts";
import { assertApiKeyDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

const keyName = "alchemy-ag-bindings-test-key";

// The API key under test is created at RUNTIME through the deployed
// Lambda's binding — it is not a stack resource, so `stack.destroy()`
// can't clean it up if the test dies between `/keys` and `/key` DELETE.
// Reap strays by their constant name (pre-clean + ensuring finalizer).
const reapApiKeys = ag.getApiKeys.pages({ nameQuery: keyName }).pipe(
  Stream.runCollect,
  Effect.map((chunk) =>
    Array.from(chunk).flatMap((page) =>
      (page.items ?? []).filter(
        (key): key is ag.ApiKey & { id: string } =>
          key.id != null && key.name === keyName,
      ),
    ),
  ),
  Effect.flatMap(
    Effect.forEach((key) =>
      ag
        .deleteApiKey({ apiKey: key.id })
        .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
    ),
  ),
  Effect.asVoid,
  // Finalizer contract: the error channel must be `never`.
  Effect.orDie,
);

// Fresh Lambda function URLs return transient errors for the first
// 30–90s (DNS, IAM propagation, cold init). Poll at a steady cadence.
const readinessSchedule = Schedule.max([
  Schedule.exponential(500).pipe(
    Schedule.modifyDelay(({ duration: d }) =>
      Effect.succeed(
        Duration.isGreaterThan(d, Duration.seconds(10))
          ? Duration.seconds(10)
          : d,
      ),
    ),
  ),
  Schedule.recurs(20),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`GET ${url} returned ${response.status}`)),
    ),
  );

const sendJson = (method: "POST" | "DELETE", url: string, body?: unknown) =>
  HttpClient.execute(
    body === undefined
      ? HttpClientRequest.make(method)(url)
      : HttpClientRequest.make(method)(url).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(
            new Error(`${method} ${url} returned ${response.status}`),
          ),
    ),
  );

test.provider.skipIf(!!process.env.FAST)(
  "ApiGateway bindings issue, meter, and manage API keys from a Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* reapApiKeys;

      const { functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ApiGatewayBindingsFunction;
        }).pipe(Effect.provide(ApiGatewayBindingsFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      // CreateApiKey + CreateUsagePlanKey — retried through cold start.
      const created = (yield* sendJson("POST", `${baseUrl}/keys`, {
        name: keyName,
      }).pipe(Effect.retry({ schedule: readinessSchedule }))) as {
        id: string;
        valueRedacted: boolean;
      };
      expect(created.id).toBeTruthy();
      // The distilled response decodes the key material to Redacted.
      expect(created.valueRedacted).toBe(true);

      // GetApiKey
      const single = (yield* getJson(`${baseUrl}/key?id=${created.id}`)) as {
        id: string;
        name: string;
        enabled: boolean;
      };
      expect(single.id).toEqual(created.id);
      expect(single.name).toEqual(keyName);
      expect(single.enabled).toBe(true);

      // GetApiKeys
      const listed = (yield* getJson(
        `${baseUrl}/keys?nameQuery=${keyName}`,
      )) as { ids: string[] };
      expect(listed.ids).toContain(created.id);

      // GetUsagePlanKey / GetUsagePlanKeys — enrollment is visible.
      const enrollment = (yield* getJson(
        `${baseUrl}/plan-key?id=${created.id}`,
      )) as { enrolled: boolean };
      expect(enrollment.enrolled).toBe(true);
      const planKeys = (yield* getJson(`${baseUrl}/plan-keys`)) as {
        ids: string[];
      };
      expect(planKeys.ids).toContain(created.id);

      // GetUsage — empty usage window is a valid, IAM-exercising read.
      const today = new Date().toISOString().slice(0, 10);
      const usage = (yield* getJson(
        `${baseUrl}/usage?startDate=${today}&endDate=${today}`,
      )) as { items: Record<string, unknown> };
      expect(usage.items).toBeDefined();

      // UpdateUsage — the plan has no quota, so the API answers with a
      // typed BadRequest (extended: false). An IAM failure would be an
      // (uncaught) auth error and fail the route with a 500.
      const extended = (yield* sendJson("POST", `${baseUrl}/extend`, {
        keyId: created.id,
      })) as { extended: boolean };
      expect(typeof extended.extended).toBe("boolean");

      // UpdateApiKey — disable the key.
      const disabled = (yield* sendJson("POST", `${baseUrl}/disable`, {
        id: created.id,
      })) as { enabled: boolean };
      expect(disabled.enabled).toBe(false);

      // FlushStageCache / FlushStageAuthorizersCache — no cache cluster on
      // the stage, so the API answers with typed BadRequest/NotFound; the
      // route reports the flush outcome instead of failing on auth.
      const flushed = (yield* sendJson("POST", `${baseUrl}/flush`)) as {
        cache: boolean;
        authorizers: boolean;
      };
      expect(typeof flushed.cache).toBe("boolean");
      expect(typeof flushed.authorizers).toBe("boolean");

      // DeleteUsagePlanKey + DeleteApiKey — cleanup through the bindings.
      const deleted = (yield* sendJson(
        "DELETE",
        `${baseUrl}/key?id=${created.id}`,
      )) as { deleted: boolean };
      expect(deleted.deleted).toBe(true);
      const afterDelete = (yield* getJson(
        `${baseUrl}/keys?nameQuery=${keyName}`,
      )) as { ids: string[] };
      expect(afterDelete.ids).not.toContain(created.id);

      yield* stack.destroy();

      // The list endpoint can briefly return a deleted key after GetApiKeys
      // has already observed the deletion. Prove the runtime-created key is
      // gone by its stable ID through the bounded typed NotFound assertion.
      yield* assertApiKeyDeleted(created.id);
    }).pipe(Effect.ensuring(reapApiKeys)),
  { timeout: 600_000 },
);

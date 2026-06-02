import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Alchemy from "@/index.ts";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Gateway } from "./fixtures/Gateway.ts";
import TestWorker from "./fixtures/TestWorker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete ai gateway with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const gateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("DefaultGateway", {
          id: "alchemy-test-ai-gateway-default",
        });
      }),
    );

    expect(gateway.gatewayId).toEqual("alchemy-test-ai-gateway-default");
    expect(gateway.cacheInvalidateOnUpdate).toEqual(false);
    expect(gateway.cacheTtl).toEqual(null);
    expect(gateway.collectLogs).toEqual(true);
    expect(gateway.rateLimitingInterval).toEqual(null);
    expect(gateway.rateLimitingLimit).toEqual(null);
    expect(gateway.rateLimitingTechnique).toEqual("fixed");

    const actualGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: gateway.gatewayId,
    });
    expect(actualGateway.id).toEqual(gateway.gatewayId);

    yield* stack.destroy();

    yield* waitForGatewayToBeDeleted(gateway.gatewayId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete ai gateway", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const gateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("TestGateway", {
          id: "alchemy-test-ai-gateway",
          cacheTtl: 60,
          collectLogs: true,
          rateLimitingInterval: 60,
          rateLimitingLimit: 100,
          rateLimitingTechnique: "fixed",
        });
      }),
    );

    const actualGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: gateway.gatewayId,
    });
    expect(actualGateway.id).toEqual(gateway.gatewayId);
    expect(actualGateway.cacheTtl).toEqual(60);
    expect(actualGateway.rateLimitingLimit).toEqual(100);

    const updatedGateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("TestGateway", {
          id: "alchemy-test-ai-gateway",
          cacheTtl: 120,
          collectLogs: true,
          rateLimitingInterval: 120,
          rateLimitingLimit: 200,
          rateLimitingTechnique: "sliding",
        });
      }),
    );

    const actualUpdatedGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: updatedGateway.gatewayId,
    });
    expect(actualUpdatedGateway.cacheTtl).toEqual(120);
    expect(actualUpdatedGateway.rateLimitingInterval).toEqual(120);
    expect(actualUpdatedGateway.rateLimitingLimit).toEqual(200);
    expect(actualUpdatedGateway.rateLimitingTechnique).toEqual("sliding");

    yield* stack.destroy();

    yield* waitForGatewayToBeDeleted(gateway.gatewayId, accountId);
  }).pipe(logLevel),
);

// Engine-level adoption: AI Gateways have no ownership signal (Cloudflare
// doesn't expose tags on AI Gateways), so a name match in `read` is treated
// as silent adoption.
test.provider(
  "existing ai gateway (matching id) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const gatewayId = `alchemy-test-aigw-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy normally so a real AI Gateway exists.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("AdoptableGateway", {
            id: gatewayId,
          });
        }),
      );
      expect(initial.gatewayId).toEqual(gatewayId);

      // Phase 2: wipe local state — the gateway stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableGateway",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which fetches the gateway by id and returns plain
      // attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("AdoptableGateway", {
            id: gatewayId,
          });
        }),
      );

      expect(adopted.gatewayId).toEqual(gatewayId);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableGateway",
        });
      }).pipe(Effect.provide(stack.state));

      expect((persisted as any)?.attr).toMatchObject({ gatewayId });

      yield* stack.destroy();
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);
    }).pipe(logLevel),
);

const waitForGatewayToBeDeleted = Effect.fn(function* (
  gatewayId: string,
  accountId: string,
) {
  yield* aiGateway
    .getAiGateway({
      accountId,
      id: gatewayId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new GatewayStillExists())),
      Effect.retry({
        while: (e): e is GatewayStillExists => e instanceof GatewayStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("GatewayNotFound", () => Effect.void),
    );
});

class GatewayStillExists extends Data.TaggedError("GatewayStillExists") {}

const Stack = Alchemy.Stack(
  "AiGatewayBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const gateway = yield* Gateway;
    const worker = yield* TestWorker;
    return {
      gatewayId: gateway.gatewayId,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker can call AiGateway binding (effect-native getUrl)",
  Effect.gen(function* () {
    const out = yield* stack;
    const workerUrl = out.url;
    expect(workerUrl).toBeTypeOf("string");
    expect(out.gatewayId).toBeTypeOf("string");
    expect(out.gatewayId.length).toBeGreaterThan(0);

    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${workerUrl}/url`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { url: string };
    // The runtime gateway exposes a stable account-scoped URL like
    // https://gateway.ai.cloudflare.com/v1/<accountId>/<gatewayId>
    expect(body.url).toContain(out.gatewayId);
    expect(body.url).toContain("gateway.ai.cloudflare.com");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

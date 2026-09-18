import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { describe, vi } from "vite-plus/test";

import { failEnvironmentAuthInvalid } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { ProviderSessionWakeTargetError } from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { orchestrationHttpApiLayer } from "./http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

class OrchestrationTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const testAuthLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      return yield* failEnvironmentAuthInvalid("missing_credential");
    }
    const token = authorization.replace(/^Bearer\s+/i, "");
    const scopes =
      token === "operate"
        ? new Set(["orchestration:read", "orchestration:operate"] as const)
        : token === "read-only"
          ? new Set(["orchestration:read"] as const)
          : undefined;
    if (scopes === undefined) {
      return yield* failEnvironmentAuthInvalid("invalid_credential");
    }
    return yield* httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("wake-test-session"),
        subject: "wake-test",
        method: "bearer-access-token",
        scopes,
      }),
    );
  }),
);

describe("orchestration HTTP provider session wake", () => {
  it.effect("rejects missing authentication before runtime work", () =>
    Effect.gen(function* () {
      const wakeSession = vi.fn(() => Effect.die("wake must not run"));
      const response = yield* postWake(
        { provider: "codex", providerThreadId: "codex-1" },
        undefined,
        wakeSession,
      );
      expect(response.status).toBe(401);
      expect(wakeSession).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects read-only credentials before runtime work", () =>
    Effect.gen(function* () {
      const wakeSession = vi.fn(() => Effect.die("wake must not run"));
      const response = yield* postWake(
        { provider: "codex", providerThreadId: "codex-1" },
        "read-only",
        wakeSession,
      );
      expect(response.status).toBe(403);
      expect(wakeSession).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the restored session after an authenticated wake", () =>
    Effect.gen(function* () {
      const wakeSession = vi.fn(() =>
        Effect.succeed({
          threadId: ThreadId.make("thread-1"),
          outcome: "restored" as const,
        }),
      );
      const response = yield* postWake(
        { provider: "codex", providerThreadId: "codex-1" },
        "operate",
        wakeSession,
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        threadId: "thread-1",
        outcome: "restored",
      });
      expect(wakeSession).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("maps a missing Codex target to a typed not-found error", () =>
    Effect.gen(function* () {
      const wakeSession = vi.fn(() =>
        Effect.fail(
          new ProviderSessionWakeTargetError({
            reason: "not_found",
            providerThreadId: "codex-missing",
          }),
        ),
      );
      const response = yield* postWake(
        { provider: "codex", providerThreadId: "codex-missing" },
        "operate",
        wakeSession,
      );
      expect(response.status).toBe(404);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        reason: "provider_session_not_found",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const postWake = (
  body: unknown,
  token: string | undefined,
  wakeSession: () => ReturnType<ProviderService["Service"]["wakeSession"]>,
) =>
  Effect.gen(function* () {
    const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-wake-http-test-" });
    const routesLayer = HttpApiBuilder.layer(OrchestrationTestApi).pipe(
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(testAuthLayer),
      Layer.provide(Layer.mock(ProviderService)({ wakeSession })),
      Layer.provide(Layer.mock(ProjectionSnapshotQuery)({})),
      Layer.provide(Layer.mock(OrchestrationEngineService)({})),
      Layer.provide(
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          get: () => Effect.succeed(null),
          discard: () => Effect.void,
        }),
      ),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer))),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (handler) =>
        Effect.promise(() =>
          handler.handler(
            new Request("http://127.0.0.1/api/orchestration/provider-session/wake", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
              },
              body: encodeJson(body),
            }),
            Context.empty(),
          ),
        ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
  });

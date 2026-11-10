import type { SDKModel, SDKUser } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vite-plus/test";

const sdkLoad = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Catalog must not load the SDK");
  }),
);
vi.mock("./sdk.ts", () => ({ loadCursorSdk: sdkLoad, isCursorSdkError: () => false }));

import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";

const user = {
  apiKeyName: "test-key",
  userEmail: "cursor@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies SDKUser;

const model = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  parameters: [],
} satisfies SDKModel;

const catalogError = () =>
  new CursorSdkCatalog.CursorSdkCatalogError({
    authenticationFailure: false,
    cause: new Error("catalog unavailable"),
  });

describe("CursorSdkCatalog", () => {
  it.effect.each([
    { route: "me", status: 200, body: user, expected: "ready" },
    {
      route: "me",
      status: 401,
      body: { error: { code: "feature_unavailable" } },
      expected: "unauthenticated",
    },
    {
      route: "me",
      status: 403,
      body: { error: { code: "feature_unavailable" } },
      expected: "no-user",
    },
    { route: "me", status: 403, body: "Forbidden", expected: "no-user" },
    { route: "me", status: 403, body: { code: "plan_required" }, expected: "plan" },
    { route: "models", status: 403, body: { error: { code: "plan_required" } }, expected: "plan" },
    { route: "models", status: 403, body: {}, expected: "blocked" },
    { route: "me", status: 503, body: "Unavailable", expected: "error" },
    { route: "models", status: 200, body: { items: [{ id: "missing-name" }] }, expected: "error" },
    { route: "me", status: 200, body: "invalid JSON", expected: "error" },
  ])(
    "reads $route HTTP $status as $expected without loading the SDK",
    ({ route, status, body, expected }) =>
      Effect.gen(function* () {
        sdkLoad.mockClear();
        const requests: Array<string> = [];
        const models = [
          {
            ...model,
            aliases: ["opus"],
            parameters: [{ id: "fast", values: [{ value: "true" }] }],
            variants: [
              {
                displayName: "Fast",
                params: [{ id: "fast", value: "true" }],
                isDefault: true,
                isMaxMode: true,
              },
            ],
          },
        ];
        const client = HttpClient.make((request) => {
          expect(request.headers.authorization).toBe("Bearer test-key");
          expect(request.method).toBe("GET");
          requests.push(request.url);
          const matches = request.url === `https://api.cursor.com/v1/${route}`;
          const responseBody = matches
            ? body
            : request.url.endsWith("/me")
              ? user
              : { items: models };
          const response =
            typeof responseBody === "string"
              ? new Response(responseBody, { status: matches ? status : 200 })
              : Response.json(responseBody, { status: matches ? status : 200 });
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        });
        const catalog = yield* CursorSdkCatalog.CursorSdkCatalog.pipe(
          Effect.provide(
            CursorSdkCatalog.layer.pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
            ),
          ),
        );
        expect(sdkLoad).not.toHaveBeenCalled();
        const result = yield* catalog.read("test-key").pipe(Effect.exit);
        expect(requests).toContain(`https://api.cursor.com/v1/${route}`);
        if (expected === "ready" || expected === "no-user") {
          expect(Exit.isSuccess(result)).toBe(true);
          if (Exit.isSuccess(result))
            expect(result.value).toEqual({
              user: expected === "no-user" ? undefined : user,
              models,
            });
        } else {
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.squash(result.cause)).toMatchObject({
              authenticationFailure: expected === "unauthenticated",
              planRequired: expected === "plan",
              accountBlocked: expected === "blocked",
            });
        }
        expect(sdkLoad).not.toHaveBeenCalled();
      }),
  );

  it.effect("shares concurrent first model discovery until the response arrives", () =>
    Effect.gen(function* () {
      const modelsEntered = yield* Deferred.make<void>();
      const secondUserEntered = yield* Deferred.make<void>();
      const response = yield* Deferred.make<ReadonlyArray<SDKModel>>();
      let userCalls = 0;
      let modelCalls = 0;
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () =>
          Effect.gen(function* () {
            userCalls += 1;
            if (userCalls === 2) yield* Deferred.succeed(secondUserEntered, undefined);
            return user;
          }),
        readModels: () =>
          Effect.gen(function* () {
            modelCalls += 1;
            yield* Deferred.succeed(modelsEntered, undefined);
            return yield* Deferred.await(response);
          }),
      });
      expect(modelCalls).toBe(0);
      const first = yield* catalog.read("test-key").pipe(Effect.forkChild);
      yield* Deferred.await(modelsEntered);
      const second = yield* catalog.read("test-key").pipe(Effect.forkChild);
      yield* Deferred.await(secondUserEntered);
      expect(modelCalls).toBe(1);
      yield* Deferred.succeed(response, [model]);
      expect((yield* Fiber.join(first)).models).toEqual([model]);
      expect((yield* Fiber.join(second)).models).toEqual([model]);
    }),
  );

  it.effect("does not cache failed or empty model discovery", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () => Effect.succeed(user),
        readModels: () =>
          Effect.suspend(() => {
            modelCalls += 1;
            if (modelCalls === 1) return Effect.fail(catalogError());
            if (modelCalls === 2) return Effect.succeed([]);
            return Effect.succeed([model]);
          }),
      });

      expect(Exit.isFailure(yield* Effect.exit(catalog.read("test-key")))).toBe(true);
      expect((yield* catalog.read("test-key")).models).toEqual([]);
      expect((yield* catalog.read("test-key")).models).toEqual([model]);
      expect((yield* catalog.read("test-key")).models).toEqual([model]);
      expect(modelCalls).toBe(3);
    }),
  );
});

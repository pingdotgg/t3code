import type { SDKModel, SDKUser } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { CursorSdkCatalogError, makeCursorSdkCatalog } from "./CursorSdkCatalog.ts";

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
  new CursorSdkCatalogError({
    authenticationFailure: false,
    cause: new Error("catalog unavailable"),
  });

describe("CursorSdkCatalog", () => {
  it.effect("keeps the user probe fresh while caching models by API key", () =>
    Effect.gen(function* () {
      let userCalls = 0;
      let modelCalls = 0;
      const catalog = yield* makeCursorSdkCatalog({
        readUser: () => Effect.sync(() => ((userCalls += 1), user)),
        readModels: () => Effect.sync(() => ((modelCalls += 1), [model])),
      });

      yield* catalog.read("first-key");
      yield* catalog.read("first-key");
      yield* catalog.read("second-key");

      expect(userCalls).toBe(3);
      expect(modelCalls).toBe(2);
    }),
  );

  it.effect("does not cache failed or empty model discovery", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const catalog = yield* makeCursorSdkCatalog({
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

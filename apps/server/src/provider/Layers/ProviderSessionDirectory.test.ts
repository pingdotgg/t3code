import { it, assert } from "@effect/vitest";
import { assertFailure, assertSome } from "@effect/vitest/utils";
import { Effect } from "effect";

import { ProviderSessionNotFoundError, ProviderValidationError } from "../Errors.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const layer = it.layer(ProviderSessionDirectoryLive);

layer("ProviderSessionDirectoryLive", (it) => {
  it("upserts, reads, and removes session bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;

      yield* directory.upsert({
        sessionId: "sess-1",
        provider: "codex",
        threadId: "thread-1",
      });

      const provider = yield* directory.getProvider("sess-1");
      assert.equal(provider, "codex");
      const threadId = yield* directory.getThreadId("sess-1");
      assertSome(threadId, "thread-1");

      yield* directory.upsert({
        sessionId: "sess-1",
        provider: "codex",
        threadId: "thread-2",
      });
      const updatedThreadId = yield* directory.getThreadId("sess-1");
      assertSome(updatedThreadId, "thread-2");

      const sessionIds = yield* directory.listSessionIds();
      assert.deepEqual(sessionIds, ["sess-1"]);

      yield* directory.remove("sess-1");
      const missingProvider = yield* directory.getProvider("sess-1").pipe(Effect.result);
      assertFailure(missingProvider, new ProviderSessionNotFoundError({ sessionId: "sess-1" }));
    }));

  it("fails upsert for empty session id", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const result = yield* Effect.result(
        directory.upsert({
          sessionId: "   ",
          provider: "codex",
        }),
      );
      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "sessionId must be a non-empty string.",
        }),
      );
    }));
});

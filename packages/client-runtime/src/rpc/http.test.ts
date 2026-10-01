import { ExtensionOperationError, SourceControlProviderError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { executeEnvironmentHttpRequest, RemoteEnvironmentAuthFetchError } from "./http.ts";

it.effect(
  "preserves an extension's actionable error instead of claiming the request failed to fetch",
  () =>
    Effect.gen(function* () {
      const diagnostic = new SourceControlProviderError({
        provider: "gitlab",
        operation: "getChangeRequest",
        cwd: "/repo",
        detail:
          "Merge request !1 was not found. If private, run `glab auth login --hostname gitlab.example` and retry.",
      });
      const error = new ExtensionOperationError({
        operation: "vcs.actions.preparePullRequestThread",
        detail: diagnostic.detail,
      });
      const received = yield* executeEnvironmentHttpRequest(
        "https://environment.example/api/extensions/api/invoke",
        30000,
        Effect.fail(error),
      ).pipe(Effect.flip);
      expect(received).toBe(error);
      expect(received.message).toBe(diagnostic.detail);
    }),
);

it.effect("retains transport failures and their causes", () =>
  Effect.gen(function* () {
    const cause = new TypeError("Network unavailable");
    const received = yield* executeEnvironmentHttpRequest(
      "https://environment.example/api/extensions/api/invoke",
      30000,
      Effect.fail(cause),
    ).pipe(Effect.flip);
    expect(received).toBeInstanceOf(RemoteEnvironmentAuthFetchError);
    expect(received).toHaveProperty("cause", cause);
  }),
);

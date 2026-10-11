import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeCodexCloudEnvironments } from "./CodexCloudEnvironments.ts";

/** Discover through a scoped native home and an HTTP boundary that never leaves the test. */
const discover = (options: {
  status?: number;
  body?: unknown;
  repositoryFailure?: boolean;
  auth?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(home, "auth.json"),
      options.auth ??
        JSON.stringify({ tokens: { access_token: "test-access", account_id: "test-account" } }),
    );
    const list = yield* makeCodexCloudEnvironments(ProviderInstanceId.make("codex-work"), home);
    return yield* list("pingdotgg/t3code");
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          assert.equal(request.headers.authorization, "Bearer test-access");
          assert.equal(request.headers["chatgpt-account-id"], "test-account");
          const byRepo = request.url.endsWith("/by-repo/github/pingdotgg/t3code");
          const status = options.status ?? (byRepo && options.repositoryFailure ? 500 : 200);
          const body =
            options.body ??
            (byRepo
              ? [{ id: "env-project", label: "T3 Code" }]
              : [
                  { id: "env-other", label: "Other" },
                  { id: "env-project", label: "T3 Code" },
                ]);
          return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
        }),
      ),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

describe("Codex Cloud environment discovery", () => {
  it.effect(
    "uses the selected account, deduplicates results, and suggests the repository match",
    () =>
      discover({}).pipe(
        Effect.map((environments) =>
          assert.deepStrictEqual(environments, [
            { id: "env-project", label: "T3 Code", repository: "pingdotgg/t3code" },
            { id: "env-other", label: "Other" },
          ]),
        ),
      ),
  );
  it.effect("keeps global environments when repository discovery fails", () =>
    discover({ repositoryFailure: true }).pipe(
      Effect.map((environments) =>
        assert.deepStrictEqual(environments, [
          { id: "env-other", label: "Other" },
          { id: "env-project", label: "T3 Code" },
        ]),
      ),
    ),
  );
  it.effect.each([
    { status: 401 },
    { body: { incompatible: [] } },
    { status: 403 },
    { auth: '{"OPENAI_API_KEY":"private-never-shown"}' },
  ])("reports discovery failures without exposing credentials: %j", (options) =>
    discover(options).pipe(
      Effect.result,
      Effect.map((result) => {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.notInclude(result.failure.message, "test-access");
      }),
    ),
  );
});

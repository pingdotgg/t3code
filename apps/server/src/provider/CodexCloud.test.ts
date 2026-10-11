import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderCloudEnvironmentMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeCodexCloud } from "./CodexCloud.ts";

const instanceId = ProviderInstanceId.make("codex-work");
const config = {
  id: "asenvcfg_test",
  name: "T3 Code",
  status: "draft",
  version_id: "version-1",
  version_revision: 1,
  thread_id: "thread-setup",
  repositories: [{ repository_id: "repo-1", ref: "main" }],
  draft: {
    id: "draft-1",
    revision: 4,
    repositories: [{ repository_id: "repo-1", ref: "main" }],
    install_script: "npm ci",
    start_skill: "npm test",
    cwd: "/workspace/t3code",
  },
};
/** Runs `use` against a scoped Codex home and an HTTP boundary that never leaves the test. */
const withCloud = <A>(
  use: (
    cloud: Effect.Success<ReturnType<typeof makeCodexCloud>>,
  ) => Effect.Effect<A, ProviderDriverError>,
  respond: (path: string, method: string, body: unknown) => { body: unknown; status?: number },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "private-access", account_id: "test-account" } }),
    );
    return yield* use(yield* makeCodexCloud(instanceId, home));
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          assert.equal(request.headers.authorization, "Bearer private-access");
          assert.equal(request.headers["chatgpt-account-id"], "test-account");
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined;
          const response = respond(new URL(request.url).pathname, request.method, body);
          return HttpClientResponse.fromWeb(
            request,
            Response.json(response.body, { status: response.status ?? 200 }),
          );
        }),
      ),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );
const run = (
  input: ProviderCloudEnvironmentMutation,
  respond: (path: string, method: string, body: unknown) => { body: unknown; status?: number },
) => withCloud((cloud) => cloud.mutate(input), respond);

describe("Codex Cloud configuration lifecycle", () => {
  it.effect(
    "creates a private configuration using repositories and refs verified on the host",
    () => {
      const calls: string[] = [];
      return run(
        {
          instanceId,
          operation: "create",
          name: "T3 Code",
          repositoryIds: ["repo-1", "repo-1"],
          network: "package_managers",
        },
        (path, method, body) => {
          calls.push(`${method} ${path}`);
          if (method === "GET")
            return {
              body: {
                id: "repo-1",
                repository_full_name: "pingdotgg/t3code",
                default_branch: "main",
              },
            };
          assert.deepStrictEqual(body, {
            name: "T3 Code",
            repositories: [{ repository_id: "repo-1", ref: "main" }],
            network_policy: { type: "restricted", presets: ["package_managers"] },
            share_settings: "private",
            start_onboarding: false,
          });
          return { body: config };
        },
      ).pipe(
        Effect.map((created) => {
          assert.equal(created?.id, "asenvcfg_test");
          assert.equal(created?.published, false);
          assert.deepStrictEqual(calls, [
            "GET /backend-api/wham/github/repositories/repo-1",
            "POST /v1/environment-configs",
          ]);
        }),
      );
    },
  );
  it.effect("does not create when a repository is inaccessible", () =>
    run(
      {
        instanceId,
        operation: "create",
        name: "T3 Code",
        repositoryIds: ["repo-1"],
        network: "disabled",
      },
      (_, method) => {
        assert.equal(method, "GET");
        return { body: { error: "private-access" }, status: 403 };
      },
    ).pipe(
      Effect.result,
      Effect.map((result) => {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.notInclude(result.failure.message, "private-access");
      }),
    ),
  );
  it.effect("finishes publication only after the matching approval operation succeeds", () => {
    const calls: string[] = [];
    return run({ instanceId, operation: "publish", id: config.id }, (path, method, body) => {
      calls.push(`${method} ${path}`);
      if (method === "GET") return { body: config };
      if (path.endsWith("/begin")) {
        assert.propertyVal(body, "expected_revision", 4);
        return {
          body: { id: "operation-1", kind: "APPROVE_ENVIRONMENT_CONFIG_DRAFT", state: "SUCCEEDED" },
        };
      }
      assert.deepStrictEqual(body, { operation_id: "operation-1", thread_id: "thread-setup" });
      return { body: { ...config, status: "ready", version_revision: 2, draft: null } };
    }).pipe(
      Effect.map((published) => {
        assert.equal(published?.published, true);
        assert.equal(calls.length, 3);
      }),
    );
  });
  it.effect("never completes a failed publish operation", () =>
    run({ instanceId, operation: "publish", id: config.id }, (path, method) => {
      assert.isFalse(path.endsWith("/complete"));
      return {
        body:
          method === "GET"
            ? config
            : { id: "operation-1", kind: "APPROVE_ENVIRONMENT_CONFIG_DRAFT", state: "FAILED" },
      };
    }).pipe(
      Effect.result,
      Effect.map((result) => assert.equal(result._tag, "Failure")),
    ),
  );
  it.effect("deletes only the explicitly selected configuration", () =>
    run({ instanceId, operation: "delete", id: config.id }, (path, method) => {
      assert.equal(path, "/v1/environment-configs/asenvcfg_test");
      assert.equal(method, "DELETE");
      return { body: {} };
    }).pipe(Effect.map((result) => assert.isNull(result))),
  );
});

describe("Codex Cloud environment discovery", () => {
  const respond = (options: { repositoryFailure?: boolean; status?: number }) => (path: string) => {
    if (path.startsWith("/v1/environment-configs"))
      return { body: { data: [{ ...config, version_revision: 2 }], next_cursor: null } };
    const byRepo = path.endsWith("/by-repo/github/pingdotgg/t3code");
    return {
      status: options.status ?? (byRepo && options.repositoryFailure ? 500 : 200),
      body: byRepo
        ? [{ id: "env-project", label: "T3 Code" }]
        : [
            { id: "env-other", label: "Other" },
            { id: "env-project", label: "T3 Code" },
          ],
    };
  };
  it.effect("lists configurations, then exec environments with the repository match first", () =>
    withCloud((cloud) => cloud.list("pingdotgg/t3code"), respond({})).pipe(
      Effect.map((environments) =>
        assert.deepStrictEqual(environments, [
          { id: "asenvcfg_test", label: "T3 Code", setup: false },
          { id: "env-project", label: "T3 Code", repository: "pingdotgg/t3code" },
          { id: "env-other", label: "Other" },
        ]),
      ),
    ),
  );
  it.effect("keeps every environment when the repository lookup fails", () =>
    withCloud((cloud) => cloud.list("pingdotgg/t3code"), respond({ repositoryFailure: true })).pipe(
      Effect.map((environments) =>
        assert.deepStrictEqual(
          environments.map((environment) => environment.id),
          ["asenvcfg_test", "env-other", "env-project"],
        ),
      ),
    ),
  );
  it.effect("reports a rejected sign-in without exposing credentials", () =>
    withCloud((cloud) => cloud.list(), respond({ status: 401 })).pipe(
      Effect.result,
      Effect.map((result) => {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.notInclude(result.failure.message, "private-access");
      }),
    ),
  );
});

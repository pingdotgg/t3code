import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderCloudEnvironmentMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeCodexCloud } from "./CodexCloud.ts";

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
const run = (
  input: ProviderCloudEnvironmentMutation,
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
    const cloud = yield* makeCodexCloud(input.instanceId, home);
    return yield* cloud.mutate(input);
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
const instanceId = ProviderInstanceId.make("codex-work");

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

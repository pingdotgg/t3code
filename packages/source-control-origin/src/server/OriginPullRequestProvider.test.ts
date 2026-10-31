import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as OriginApi from "./OriginApi.ts";
import * as OriginCredentials from "./OriginCredentials.ts";
import * as OriginPullRequestProvider from "./OriginPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const pull = {
  id: "pr_1",
  number: "17",
  state: "open",
  draft: false,
  merged: false,
  title: "Add telemetry",
  body: "Body",
  head: { ref: "feature", sha: "abc" },
  base: { ref: "main", sha: "def" },
  author: { user: { id: "user_1", email: "alice@example.com", handle: "alice" } },
  createdAt: "2026-09-12T12:00:00Z",
  updatedAt: "2026-09-12T12:00:00Z",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  labels: [],
  webUrl: "https://cursor.com/codebase/team/project/pull/17",
};

describe("OriginPullRequestProvider", () => {
  it.effect("serves Origin remote and web hosts and rejects mirrored repos", () => {
    const client = HttpClient.make((request) => {
      if (request.url.endsWith("/repos/team/project")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              encodeJson({
                id: "repo_1",
                name: "project",
                mirror: { source: "github", status: "inbound" },
              }),
            ),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 })),
      );
    });
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      assert.isTrue(provider.servesHost?.("origin.cursor.com"));
      assert.isTrue(provider.servesHost?.("cursor.com"));
      assert.isFalse(provider.servesHost?.("github.com"));
      const error = yield* provider
        .getChangeRequest({
          cwd: "/repo",
          host: "cursor.com",
          repository: "team/project",
          number: 17,
        })
        .pipe(Effect.flip);
      assert.include(error.detail, "mirrored GitHub");
    }).pipe(
      Effect.provide(
        OriginApi.layer.pipe(
          Layer.provideMerge(OriginCredentials.layer),
          Layer.provideMerge(TestSourceControlHost.layer()),
          Layer.provide(Layer.succeed(HostProcess.Environment, { CURSOR_AUTH_TOKEN: "env-token" })),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });

  it.effect("reads a native pull request detail", () => {
    const client = HttpClient.make((request) => {
      const url = request.url;
      let body: unknown = {};
      if (url.endsWith("/repos/team/project")) {
        body = { id: "repo_1", name: "project", allowMergeCommit: true, allowSquashMerge: true };
      } else if (url.includes("/pulls/17/mergeability")) {
        body = { verdict: "mergeable", blockers: [] };
      } else if (url.includes("/requested_reviewers")) {
        body = { reviewers: [], users: [] };
      } else if (url.includes("/collaborators/")) {
        body = { permission: "write", user: { id: "user_1", email: "alice@example.com" } };
      } else if (url.includes("/pulls/17")) {
        body = pull;
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(encodeJson(body))));
    });
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/repo",
        host: "cursor.com",
        repository: "team/project",
        number: 17,
      });
      assert.strictEqual(detail.number, 17);
      assert.strictEqual(detail.state, "open");
      assert.strictEqual(detail.mergeability, "mergeable");
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: true,
        squash: true,
        rebase: false,
      });
      assert.include(detail.viewerPermissions.actions, "merge");
    }).pipe(
      Effect.provide(
        OriginApi.layer.pipe(
          Layer.provideMerge(OriginCredentials.layer),
          Layer.provideMerge(TestSourceControlHost.layer()),
          Layer.provide(Layer.succeed(HostProcess.Environment, { CURSOR_AUTH_TOKEN: "env-token" })),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });
});

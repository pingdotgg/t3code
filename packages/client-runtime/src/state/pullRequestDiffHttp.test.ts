import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  fetchEnvironmentPullRequestDiff,
  PullRequestDiffCredentialRejectedError,
} from "./pullRequestDiffHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

describe("fetchEnvironmentPullRequestDiff", () => {
  it.effect("posts the diff input to the prepared environment over authenticated HTTP", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(
          Response.json({
            patch: "diff --git a/file.ts b/file.ts",
            truncated: false,
            nextCursor: null,
          }),
        );
      }) satisfies typeof fetch;

      const result = yield* fetchEnvironmentPullRequestDiff({
        prepared: PREPARED,
        signer: Option.none(),
        diff: {
          projectId: ProjectId.make("project-1"),
          repository: "owner/repository",
          number: 42,
          cursor: "next-page",
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(result).toEqual({
        patch: "diff --git a/file.ts b/file.ts",
        truncated: false,
        nextCursor: null,
      });
      expect(calls).toHaveLength(1);
      const [request, init] = calls[0]!;
      expect(String(request)).toBe("https://environment.example.test/api/pull-requests/diff");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");

      const body =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : "";
      // The assertion deliberately inspects the serialized wire body rather than decoding a
      // domain value for use in application code.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(body)).toEqual({
        projectId: "project-1",
        repository: "owner/repository",
        number: 42,
        cursor: "next-page",
      });
    }),
  );

  it.effect("gives rejected diff sessions a recovery action", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "trace-auth-test",
            },
            { status: 401 },
          ),
        )) satisfies typeof fetch;

      const error = yield* fetchEnvironmentPullRequestDiff({
        prepared: PREPARED,
        signer: Option.none(),
        diff: {
          projectId: ProjectId.make("project-1"),
          repository: "owner/repository",
          number: 42,
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)), Effect.flip);

      expect(error).toBeInstanceOf(PullRequestDiffCredentialRejectedError);
      expect(error).toMatchObject({
        repository: "owner/repository",
        number: 42,
        traceId: "trace-auth-test",
      });
      expect(error.message).toBe(
        "This environment session is no longer valid (invalid_credential). Refresh the page or quit and reopen T3 Code.",
      );
    }),
  );
});

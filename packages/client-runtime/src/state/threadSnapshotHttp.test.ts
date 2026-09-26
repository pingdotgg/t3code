import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ThreadSnapshotLoader, threadSnapshotLoaderLayer } from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const THREAD_ID = ThreadId.make("thread-1");

function provideLoader(fetchFn: typeof fetch) {
  return Effect.provide(
    threadSnapshotLoaderLayer.pipe(Layer.provide(remoteHttpClientLayer(fetchFn))),
  );
}

describe("ThreadSnapshotLoader", () => {
  it.effect("preserves the decoded thread_not_found response", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "EnvironmentResourceNotFoundError",
            code: "not_found",
            reason: "thread_not_found",
            traceId: "trace-thread-not-found",
          },
          { status: 404 },
        ),
      )) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader;
      const error = yield* Effect.flip(loader.load(PREPARED, THREAD_ID));

      expect(error).toMatchObject({
        _tag: "EnvironmentResourceNotFoundError",
        code: "not_found",
        reason: "thread_not_found",
        traceId: "trace-thread-not-found",
      });
    }).pipe(provideLoader(fetchFn));
  });

  it.effect("maps a transient HTTP failure to the socket fallback", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "EnvironmentInternalError",
            code: "internal_error",
            reason: "orchestration_thread_snapshot_failed",
            traceId: "trace-thread-snapshot-failed",
          },
          { status: 500 },
        ),
      )) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader;
      const snapshot = yield* loader.load(PREPARED, THREAD_ID);

      expect(Option.isNone(snapshot)).toBe(true);
    }).pipe(provideLoader(fetchFn));
  });
});

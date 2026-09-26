import { assert, it } from "@effect/vitest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { EnvironmentInternalError } from "@t3tools/contracts";

import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  isProjectLiveServerConnectionRefusedError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
  assert.isFalse(isProjectLiveServerConnectionRefusedError(error));
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it("classifies only transport failures with an exact ECONNREFUSED code", () => {
  const request = HttpClientRequest.get("http://127.0.0.1:1/");
  const makeRequestError = (cause: unknown) =>
    projectCommandErrorFromLiveServerRequest(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause }),
      }),
    );

  const refused = Object.assign(new Error("connection failed"), { code: "ECONNREFUSED" });
  const nestedRefused = Object.assign(new Error("wrapped connection failure"), { cause: refused });

  assert.isTrue(isProjectLiveServerConnectionRefusedError(makeRequestError(refused)));
  assert.isTrue(isProjectLiveServerConnectionRefusedError(makeRequestError(nestedRefused)));
  assert.isFalse(
    isProjectLiveServerConnectionRefusedError(
      makeRequestError(new Error("connect ECONNREFUSED 127.0.0.1:1")),
    ),
  );
  assert.isFalse(
    isProjectLiveServerConnectionRefusedError(
      makeRequestError(Object.assign(new Error("connection reset"), { code: "ECONNRESET" })),
    ),
  );
  assert.isFalse(isProjectLiveServerConnectionRefusedError(new Error("connection failed")));
});

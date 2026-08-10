import { assert, it } from "@effect/vitest";

import { EnvironmentInternalError } from "@t3tools/contracts";

import {
  ProjectFolderMutationNoOpError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  ProjectPrimaryFolderNotListedError,
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
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it("explains that --primary must name one of the given paths", () => {
  const error = new ProjectPrimaryFolderNotListedError({
    operation: "addProject",
    primary: "/repo/docs",
  });

  assert.strictEqual(error.message, "--primary '/repo/docs' must be one of the given paths.");
});

it("explains each no-op folder mutation in terms the user can act on", () => {
  const make = (kind: "add" | "remove" | "promote") =>
    new ProjectFolderMutationNoOpError({
      operation: "mutateProjectFolder",
      kind,
      folder: "/repo/docs",
    }).message;

  assert.strictEqual(make("add"), "Project already owns folder '/repo/docs'.");
  // Removing the primary is refused rather than silently repointing the
  // project, so the message has to name the way forward.
  assert.match(make("remove"), /promote another folder first/);
  assert.match(make("promote"), /already the primary folder/);
});

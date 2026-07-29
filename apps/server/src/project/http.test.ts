import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ProjectConflictError,
  ProjectNotFoundError,
  ProjectOperationError,
} from "./ProjectService.ts";
import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import { failProjectMutation } from "./http.ts";

const projectId = ProjectId.make("project:http-mutation");

it.effect.each([
  new ProjectNotFoundError({ projectId }),
  new ProjectConflictError({
    projectId,
    workspaceRoot: "/workspace/project",
    conflictingProjectId: ProjectId.make("project:http-mutation-conflict"),
  }),
])("maps expected project mutation failures to invalid requests", (cause) =>
  Effect.gen(function* () {
    const error = yield* failProjectMutation(cause).pipe(Effect.flip);

    assert.equal(error._tag, "EnvironmentRequestInvalidError");
    assert.equal(error.code, "invalid_request");
    assert.equal(error.reason, "invalid_command");
  }),
);

it.effect.each([
  new ProjectOperationError({
    operation: "dispatch-project-command",
    projectId,
    cause: "database unavailable",
  }),
  new ServerRuntimeStartupError({
    mode: "web",
    host: null,
    port: 0,
    cause: "startup unavailable",
  }),
])("keeps operational and startup failures internal", (cause) =>
  Effect.gen(function* () {
    const error = yield* failProjectMutation(cause).pipe(Effect.flip);

    assert.equal(error._tag, "EnvironmentInternalError");
    assert.equal(error.code, "internal_error");
    assert.equal(error.reason, "project_mutation_failed");
  }),
);

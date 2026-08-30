import { assert, it } from "@effect/vitest";
import { CommandId, type Project, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  type ProjectCreateInput,
  ProjectConflictError,
  ProjectNotEmptyError,
  ProjectNotFoundError,
  ProjectOperationError,
  ProjectService,
  type ProjectUpdateInput,
} from "./ProjectService.ts";
import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import { failProjectMutation, projectMutationOperation } from "./http.ts";

const projectId = ProjectId.make("project:http-mutation");

const project: Project = {
  id: projectId,
  title: "HTTP project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
  deletedAt: null,
};

it.effect(
  "forwards project defaults through HTTP mutations without collapsing omission and null",
  () =>
    Effect.gen(function* () {
      const createInputs = yield* Ref.make<ReadonlyArray<ProjectCreateInput>>([]);
      const updateInputs = yield* Ref.make<ReadonlyArray<ProjectUpdateInput>>([]);
      const projectLayer = Layer.mock(ProjectService)({
        create: (input) =>
          Ref.update(createInputs, (inputs) => [...inputs, input]).pipe(Effect.as(project)),
        update: (input) =>
          Ref.update(updateInputs, (inputs) => [...inputs, input]).pipe(Effect.as(project)),
      });

      yield* Effect.gen(function* () {
        const projects = yield* ProjectService;
        yield* projectMutationOperation(projects, {
          type: "project.create",
          commandId: CommandId.make("command:http-project:create-supplied"),
          projectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultThreadEnvMode: "worktree",
          faviconPath: "/workspace/project/icon.png",
        });
        yield* projectMutationOperation(projects, {
          type: "project.create",
          commandId: CommandId.make("command:http-project:create-omitted"),
          projectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        });
        yield* projectMutationOperation(projects, {
          type: "project.create",
          commandId: CommandId.make("command:http-project:create-null"),
          projectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          createWorkspaceRootIfMissing: false,
          defaultThreadEnvMode: null,
          faviconPath: null,
        });
        yield* projectMutationOperation(projects, {
          type: "project.update",
          commandId: CommandId.make("command:http-project:update-supplied"),
          projectId,
          defaultThreadEnvMode: "worktree",
          faviconPath: "/workspace/project/icon.png",
        });
        yield* projectMutationOperation(projects, {
          type: "project.update",
          commandId: CommandId.make("command:http-project:update-omitted"),
          projectId,
        });
        yield* projectMutationOperation(projects, {
          type: "project.update",
          commandId: CommandId.make("command:http-project:update-null"),
          projectId,
          defaultThreadEnvMode: null,
          faviconPath: null,
        });
      }).pipe(Effect.provide(projectLayer));

      const [createSupplied, createOmitted, createNullAndFalse] = yield* Ref.get(createInputs);
      const [updateSupplied, updateOmitted, updateNull] = yield* Ref.get(updateInputs);

      assert.equal(createSupplied?.defaultThreadEnvMode, "worktree");
      assert.equal(createSupplied?.faviconPath, "/workspace/project/icon.png");
      assert.strictEqual(createSupplied?.createWorkspaceRootIfMissing, true);
      assert.equal(Object.hasOwn(createOmitted!, "defaultThreadEnvMode"), false);
      assert.equal(Object.hasOwn(createOmitted!, "faviconPath"), false);
      assert.equal(Object.hasOwn(createOmitted!, "createWorkspaceRootIfMissing"), false);
      assert.strictEqual(createNullAndFalse?.defaultThreadEnvMode, null);
      assert.strictEqual(createNullAndFalse?.faviconPath, null);
      assert.strictEqual(createNullAndFalse?.createWorkspaceRootIfMissing, false);
      assert.equal(updateSupplied?.defaultThreadEnvMode, "worktree");
      assert.equal(updateSupplied?.faviconPath, "/workspace/project/icon.png");
      assert.equal(Object.hasOwn(updateOmitted!, "defaultThreadEnvMode"), false);
      assert.equal(Object.hasOwn(updateOmitted!, "faviconPath"), false);
      assert.strictEqual(updateNull?.defaultThreadEnvMode, null);
      assert.strictEqual(updateNull?.faviconPath, null);
    }),
);

it.effect.each([
  new ProjectNotFoundError({ projectId }),
  new ProjectNotEmptyError({ projectId }),
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

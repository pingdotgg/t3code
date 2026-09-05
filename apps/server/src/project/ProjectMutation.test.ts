import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { projectMutationOperation } from "./ProjectMutation.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project:mutation-mapping");
const project = {
  id: projectId,
  title: "Mapping",
  workspaceRoot: "/work/mapping",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

it.effect("preserves every project mutation field", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projects = ProjectService.ProjectService.of({
      create: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      bootstrap: () => Effect.die("Unused in mutation mapping test"),
      update: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      delete: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      getById: () => Effect.die("Unused in mutation mapping test"),
      getByWorkspaceRoot: () => Effect.die("Unused in mutation mapping test"),
      snapshot: Effect.die("Unused in mutation mapping test"),
    });

    yield* Effect.gen(function* () {
      yield* projectMutationOperation({
        type: "project.create",
        commandId: CommandId.make("command:create"),
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      });
      yield* projectMutationOperation({
        type: "project.update",
        commandId: CommandId.make("command:update"),
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
      });
      yield* projectMutationOperation({
        type: "project.delete",
        commandId: CommandId.make("command:delete"),
        projectId,
        force: true,
      });
    }).pipe(Effect.provideService(ProjectService.ProjectService, projects));

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        commandId: "command:update",
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
      },
      { commandId: "command:delete", projectId, force: true },
    ]);
  }),
);

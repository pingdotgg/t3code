import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectSourceFolder,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { requireActiveProjectFoldersAbsent } from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const makeProject = (input: {
  id: string;
  workspaceRoot: string;
  additionalFolders?: ReadonlyArray<ProjectSourceFolder>;
  deletedAt?: string | null;
}): OrchestrationProject => ({
  id: ProjectId.make(input.id),
  title: input.id,
  workspaceRoot: input.workspaceRoot,
  additionalFolders: input.additionalFolders ?? [],
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  scripts: [],
  createdAt: now,
  updatedAt: now,
  deletedAt: input.deletedAt ?? null,
});

const makeReadModel = (projects: ReadonlyArray<OrchestrationProject>): OrchestrationReadModel => ({
  snapshotSequence: projects.length,
  updatedAt: now,
  projects,
  threads: [],
});

const command = {
  type: "project.create",
  commandId: CommandId.make("cmd-1"),
  projectId: ProjectId.make("project-new"),
  title: "New",
  workspaceRoot: "/tmp/project-new",
  createdAt: now,
} as OrchestrationCommand;

const check = (input: {
  projects: ReadonlyArray<OrchestrationProject>;
  folders: ReadonlyArray<string>;
  exceptProjectId?: string;
}) =>
  requireActiveProjectFoldersAbsent({
    readModel: makeReadModel(input.projects),
    command,
    folders: input.folders,
    ...(input.exceptProjectId !== undefined
      ? { exceptProjectId: ProjectId.make(input.exceptProjectId) }
      : {}),
  });

const projectA = makeProject({ id: "project-a", workspaceRoot: "/tmp/project-a" });
const projectB = makeProject({ id: "project-b", workspaceRoot: "/tmp/project-b" });

it.effect("allows folders no active project owns", () =>
  Effect.gen(function* () {
    yield* check({ projects: [projectA, projectB], folders: ["/tmp/fresh", "/tmp/fresh-2"] });
  }),
);

it.effect("rejects a folder already owned as another project's primary", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      check({ projects: [projectA, projectB], folders: ["/tmp/project-a"] }),
    );
    assert.include(
      error.detail,
      "Active project 'project-a' already owns folder '/tmp/project-a'.",
    );
  }),
);

it.effect("rejects a folder already owned as another project's additional folder", () =>
  Effect.gen(function* () {
    const owner = makeProject({
      id: "project-a",
      workspaceRoot: "/tmp/project-a",
      additionalFolders: [{ path: "/tmp/shared" }],
    });
    const error = yield* Effect.flip(check({ projects: [owner], folders: ["/tmp/shared"] }));
    assert.include(error.detail, "Active project 'project-a' already owns folder '/tmp/shared'.");
  }),
);

it.effect("rejects an additional folder that collides with another project's primary", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      check({ projects: [projectA, projectB], folders: ["/tmp/fresh", "/tmp/project-b"] }),
    );
    assert.include(
      error.detail,
      "Active project 'project-b' already owns folder '/tmp/project-b'.",
    );
  }),
);

it.effect("rejects duplicates within a single command", () =>
  Effect.gen(function* () {
    // Catches an additional folder equal to a primary the command left alone —
    // the Normalizer has no read model and cannot see that case.
    const error = yield* Effect.flip(
      check({ projects: [projectA], folders: ["/tmp/fresh", "/tmp/fresh/"] }),
    );
    assert.include(error.detail, "is listed more than once for this project");
  }),
);

it.effect("ignores the project being updated", () =>
  Effect.gen(function* () {
    const owner = makeProject({
      id: "project-a",
      workspaceRoot: "/tmp/project-a",
      additionalFolders: [{ path: "/tmp/shared" }],
    });
    yield* check({
      projects: [owner],
      folders: ["/tmp/project-a", "/tmp/shared"],
      exceptProjectId: "project-a",
    });
  }),
);

it.effect("ignores deleted projects", () =>
  Effect.gen(function* () {
    const deleted = makeProject({
      id: "project-gone",
      workspaceRoot: "/tmp/project-gone",
      additionalFolders: [{ path: "/tmp/gone-extra" }],
      deletedAt: now,
    });
    yield* check({ projects: [deleted], folders: ["/tmp/project-gone", "/tmp/gone-extra"] });
  }),
);

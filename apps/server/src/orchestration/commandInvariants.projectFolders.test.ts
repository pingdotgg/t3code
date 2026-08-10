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

import { requireProjectFoldersDistinct } from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const makeProject = (input: {
  id: string;
  workspaceRoot: string;
  additionalFolders?: ReadonlyArray<ProjectSourceFolder>;
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
  deletedAt: null,
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
}) =>
  requireProjectFoldersDistinct({
    readModel: makeReadModel(input.projects),
    command,
    folders: input.folders,
  });

const existing = makeProject({
  id: "project-a",
  workspaceRoot: "/repo/app",
  additionalFolders: [{ path: "/repo/design-system" }],
});

it.effect("allows a new project to reuse another project's primary folder", () =>
  Effect.gen(function* () {
    // Several projects may span the same code with different folder sets;
    // sidebar identity is the project id, so they stay distinguishable.
    yield* check({ projects: [existing], folders: ["/repo/app"] });
  }),
);

it.effect("allows two projects to share an additional folder", () =>
  Effect.gen(function* () {
    yield* check({ projects: [existing], folders: ["/repo/other", "/repo/design-system"] });
  }),
);

it.effect("allows the exact same folder set as an existing project", () =>
  Effect.gen(function* () {
    yield* check({ projects: [existing], folders: ["/repo/app", "/repo/design-system"] });
  }),
);

it.effect("still rejects the same folder listed twice in one project", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      check({ projects: [existing], folders: ["/repo/app", "/repo/app/"] }),
    );
    assert.include(error.detail, "is listed more than once for this project");
  }),
);

it.effect("compares folders case-insensitively on Windows paths", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      check({ projects: [], folders: ["C:/Repo/App", "c:\\repo\\app"] }),
    );
    assert.include(error.detail, "is listed more than once for this project");
  }),
);

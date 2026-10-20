import { assert, describe, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  planProjectCommand,
  type ProjectCommand,
  type ProjectCommandState,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const update = (
  fields: Omit<
    Extract<ProjectCommand, { type: "project.meta.update" }>,
    "type" | "commandId" | "projectId"
  >,
) =>
  plan(
    {
      type: "project.meta.update",
      commandId: CommandId.make("cmd-update"),
      projectId,
      ...fields,
    },
    { project: row() },
  );

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("creates projects with empty scripts and no model default", () => {
    const result = plan({
      type: "project.create",
      commandId: CommandId.make("cmd-create"),
      projectId,
      title: "Scripts",
      workspaceRoot: "/tmp/scripts",
    });
    const event = Result.getOrThrow(result);
    assert.equal(event.type, "project.created");
    assert.equal(event.occurredAt, "2026-01-01T00:00:00.000Z");
    assert.deepInclude(event.payload, { scripts: [], defaultModelSelection: null });
  });

  it("carries every edited field and omits the rest", () => {
    const payload = payloadOf(
      update({
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
      }),
    );
    assert.deepInclude(payload, {
      faviconPath: "brand/icon.svg",
      projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
    });
    const renamed = payloadOf(update({ title: "Renamed" }));
    assert.isFalse("faviconPath" in renamed);
    assert.isFalse("scripts" in renamed);
  });

  it("limits monograms to two graphemes", () => {
    for (const text of ["T3", "é", "किखि", "क्ष्म", "각"]) {
      const monogram = { kind: "monogram", text, color: "violet" } as const;
      assert.deepEqual(payloadOf(update({ projectIcon: monogram })).projectIcon, monogram);
    }
    for (const text of ["ABC", "किखिगि"]) {
      assert.equal(
        failureOf(update({ projectIcon: { kind: "monogram", text, color: "violet" } }))._tag,
        "ProjectCommandInvariantError",
      );
    }
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });

  it("deletes with a single project.deleted event", () => {
    const event = Result.getOrThrow(
      plan(
        { type: "project.delete", commandId: CommandId.make("cmd-delete"), projectId },
        { project: row() },
      ),
    );
    assert.equal(event.type, "project.deleted");
    assert.deepEqual(event.payload, { projectId, deletedAt: "2026-01-01T00:00:00.000Z" });
  });
});

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type ProjectScript,
} from "@t3tools/contracts";
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

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
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

  it("only treats metadata updates as explicit model defaults", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    assert.deepEqual(
      payloadOf(update({ defaultModelSelection: selection })).defaultModelSelection,
      selection,
    );
  });

  it("carries every edited field and omits the rest", () => {
    const scripts = [script("lint")];
    const payload = payloadOf(
      update({
        scripts,
        defaultThreadEnvMode: "worktree",
        autoPull: true,
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
      }),
    );
    assert.deepInclude(payload, {
      scripts,
      defaultThreadEnvMode: "worktree",
      autoPull: true,
      faviconPath: "brand/icon.svg",
      projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
    });
    const renamed = payloadOf(update({ title: "Renamed" }));
    assert.isFalse("defaultThreadEnvMode" in renamed);
    assert.isNull(payloadOf(update({ defaultThreadEnvMode: null })).defaultThreadEnvMode);
  });

  for (const id of ["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)]) {
    it(`rejects a new script ID that cannot have a shortcut: ${id}`, () => {
      const failure = failureOf(update({ scripts: [script("lint"), script(id)] }));
      assert.equal(failure._tag, "ProjectCommandInvariantError");
      assert.include(failure.message, "Script ID");
      assert.include(failure.message, "24");
      // The detail is persisted in the rejected receipt, so it omits the raw ID.
      assert.notInclude(failure.message, `'${id}'`);
    });
  }

  it("accepts a script ID at the shortcut length limit", () => {
    const scripts = [script("a".repeat(24))];
    assert.deepEqual(payloadOf(update({ scripts })).scripts, scripts);
  });

  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
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

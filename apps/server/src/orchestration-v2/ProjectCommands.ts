import {
  type CommandId,
  type EventId,
  type ProjectIconOverride,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

/**
 * A project's model, thread mode, auto-pull and scripts are settings, not
 * aggregate state; ProjectService writes them to its settings override.
 */
export interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  // Only ever cleared here: until settings are folded, resolving falls back to
  // the row's copy once the override is gone, so a reset must reach it too.
  readonly defaultModelSelection?: null;
  readonly defaultThreadEnvMode?: null;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export type ProjectCommand = ProjectCreateCommand | ProjectMetaUpdateCommand | ProjectDeleteCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  readonly project: ProjectRow | undefined;
  readonly workspaceOwner: ProjectRow | undefined;
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The caller reads `state` under the project's lock and commits the planned
 * event.
 */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}

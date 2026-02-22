import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ProjectAddInput,
  ProjectAddResult,
  ProjectListResult,
  ProjectRecord,
  ProjectScript,
  ProjectUpdateScriptsInput,
  ProjectUpdateScriptsResult,
} from "@t3tools/contracts";
import {
  normalizeProjectScripts,
  projectAddInputSchema,
  projectRecordSchema,
  projectRemoveInputSchema,
  projectScriptsSchema,
  projectUpdateScriptsInputSchema,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  PersistenceDecodeError,
  ProjectNotFoundError,
  ProjectPathMissingError,
  ProjectValidationError,
  toPersistenceDecodeCauseError,
  toPersistenceSerializationError,
  toPersistenceSqlError,
  type ProjectRepositoryError,
} from "../Errors.ts";
import { ProjectRepository, type ProjectRepositoryShape } from "../Services/Projects.ts";

const ProjectRowSchema = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  name: Schema.String,
  scriptsJson: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const FindByIdRequestSchema = Schema.Struct({
  id: Schema.String,
});

const FindByCwdRequestSchema = Schema.Struct({
  cwd: Schema.String,
});

const InsertProjectRequestSchema = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  name: Schema.String,
  scriptsJson: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const UpdateScriptsRequestSchema = Schema.Struct({
  id: Schema.String,
  scriptsJson: Schema.String,
  updatedAt: Schema.String,
});

const DeleteProjectRequestSchema = Schema.Struct({
  id: Schema.String,
});

function cloneScripts(scripts: readonly ProjectScript[]): ProjectScript[] {
  const cloned: ProjectScript[] = [];
  for (const script of scripts) {
    cloned.push({
      id: script.id,
      name: script.name,
      command: script.command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
    });
  }
  return cloned;
}

function normalizeCwd(rawCwd: string): string {
  const resolved = path.resolve(rawCwd.trim());
  const normalized = path.normalize(resolved);
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function isDirectory(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function inferProjectName(cwd: string): string {
  const name = path.basename(cwd);
  return name.length > 0 ? name : "project";
}

function parseProjectScripts(
  value: unknown,
  operation: string,
): Effect.Effect<ProjectScript[], PersistenceDecodeError> {
  const parsed = projectScriptsSchema.safeParse(value);
  if (!parsed.success) {
    return Effect.fail(
      new PersistenceDecodeError({
        operation,
        issue: parsed.error.message,
        cause: (parsed.error as { cause?: unknown }).cause,
      }),
    );
  }
  return Effect.succeed(normalizeProjectScripts(parsed.data));
}

function decodeScriptsJson(
  raw: string,
  operation: string,
): Effect.Effect<ProjectScript[], ProjectRepositoryError> {
  return Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: toPersistenceDecodeCauseError(`${operation}:parseScriptsJson`),
  }).pipe(Effect.flatMap((value) => parseProjectScripts(value, `${operation}:decodeScripts`)));
}

function rowToProjectRecord(
  row: Schema.Schema.Type<typeof ProjectRowSchema>,
  operation: string,
): Effect.Effect<ProjectRecord, ProjectRepositoryError> {
  return decodeScriptsJson(row.scriptsJson, `${operation}:scripts`).pipe(
    Effect.flatMap((scripts) => {
      const parsed = projectRecordSchema.safeParse({
        id: row.id,
        cwd: row.cwd,
        name: row.name,
        scripts,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      if (!parsed.success) {
        return Effect.fail(
          new PersistenceDecodeError({
            operation: `${operation}:projectRecord`,
            issue: parsed.error.message,
            cause: (parsed.error as { cause?: unknown }).cause,
          }),
        );
      }
      return Effect.succeed(parsed.data);
    }),
  );
}

function decodeAddInput(rawInput: ProjectAddInput) {
  const parsed = projectAddInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return Effect.fail(
      new ProjectValidationError({
        operation: "ProjectRepository.add",
        issue: parsed.error.message,
        cause: (parsed.error as { cause?: unknown }).cause,
      }),
    );
  }
  return Effect.succeed(parsed.data);
}

function decodeUpdateScriptsInput(rawInput: ProjectUpdateScriptsInput) {
  const parsed = projectUpdateScriptsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return Effect.fail(
      new ProjectValidationError({
        operation: "ProjectRepository.updateScripts",
        issue: parsed.error.message,
        cause: (parsed.error as { cause?: unknown }).cause,
      }),
    );
  }
  return Effect.succeed(parsed.data);
}

function decodeRemoveInput(rawInput: unknown) {
  const parsed = projectRemoveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return Effect.fail(
      new ProjectValidationError({
        operation: "ProjectRepository.remove",
        issue: parsed.error.message,
        cause: (parsed.error as { cause?: unknown }).cause,
      }),
    );
  }
  return Effect.succeed(parsed.data);
}

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectRowSchema,
    execute: () =>
      sql`
        SELECT
          id,
          cwd,
          name,
          scripts_json AS "scriptsJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projects
        ORDER BY created_at DESC
      `,
  });

  const findProjectById = SqlSchema.findOneOption({
    Request: FindByIdRequestSchema,
    Result: ProjectRowSchema,
    execute: ({ id }) =>
      sql`
        SELECT
          id,
          cwd,
          name,
          scripts_json AS "scriptsJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projects
        WHERE id = ${id}
      `,
  });

  const findProjectByCwd = SqlSchema.findOneOption({
    Request: FindByCwdRequestSchema,
    Result: ProjectRowSchema,
    execute: ({ cwd }) =>
      sql`
        SELECT
          id,
          cwd,
          name,
          scripts_json AS "scriptsJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projects
        WHERE cwd = ${cwd}
      `,
  });

  const insertProject = SqlSchema.findOne({
    Request: InsertProjectRequestSchema,
    Result: ProjectRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO projects (
          id,
          cwd,
          name,
          scripts_json,
          created_at,
          updated_at
        )
        VALUES (
          ${request.id},
          ${request.cwd},
          ${request.name},
          ${request.scriptsJson},
          ${request.createdAt},
          ${request.updatedAt}
        )
        RETURNING
          id,
          cwd,
          name,
          scripts_json AS "scriptsJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const updateProjectScripts = SqlSchema.findOne({
    Request: UpdateScriptsRequestSchema,
    Result: ProjectRowSchema,
    execute: (request) =>
      sql`
        UPDATE projects
        SET
          scripts_json = ${request.scriptsJson},
          updated_at = ${request.updatedAt}
        WHERE id = ${request.id}
        RETURNING
          id,
          cwd,
          name,
          scripts_json AS "scriptsJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const deleteProject = SqlSchema.void({
    Request: DeleteProjectRequestSchema,
    execute: ({ id }) => sql`DELETE FROM projects WHERE id = ${id}`,
  });

  const list: ProjectRepositoryShape["list"] = () =>
    listProjectRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectRepository.list:query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          rowToProjectRecord(row, "ProjectRepository.list:rowToProject"),
        ),
      ),
      Effect.map(
        (projects): ProjectListResult =>
          projects.map((project) => ({ ...project, scripts: cloneScripts(project.scripts) })),
      ),
    );

  const add: ProjectRepositoryShape["add"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* decodeAddInput(rawInput);
      const normalizedCwd = normalizeCwd(input.cwd);
      if (!isDirectory(normalizedCwd)) {
        return yield* Effect.fail(new ProjectPathMissingError({ cwd: normalizedCwd }));
      }

      const existing = yield* findProjectByCwd({ cwd: normalizedCwd }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectRepository.add:findByCwd")),
      );
      if (Option.isSome(existing)) {
        const project = yield* rowToProjectRecord(existing.value, "ProjectRepository.add:existing");
        const result: ProjectAddResult = {
          project: {
            ...project,
            scripts: cloneScripts(project.scripts),
          },
          created: false,
        };
        return result;
      }

      const now = new Date().toISOString();
      const row = yield* insertProject({
        id: randomUUID(),
        cwd: normalizedCwd,
        name: inferProjectName(normalizedCwd),
        scriptsJson: "[]",
        createdAt: now,
        updatedAt: now,
      }).pipe(Effect.mapError(toPersistenceSqlError("ProjectRepository.add:insert")));

      const created = yield* rowToProjectRecord(row, "ProjectRepository.add:created");
      const result: ProjectAddResult = {
        project: {
          ...created,
          scripts: cloneScripts(created.scripts),
        },
        created: true,
      };
      return result;
    });

  const remove: ProjectRepositoryShape["remove"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* decodeRemoveInput(rawInput);
      const existing = yield* findProjectById({ id: input.id }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectRepository.remove:findById")),
      );
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId: input.id });
      }

      yield* deleteProject({ id: input.id }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectRepository.remove:delete")),
      );
    });

  const updateScripts: ProjectRepositoryShape["updateScripts"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* decodeUpdateScriptsInput(rawInput);
      const existing = yield* findProjectById({ id: input.id }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectRepository.updateScripts:findById")),
      );
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId: input.id });
      }

      const nextScripts = yield* parseProjectScripts(
        input.scripts,
        "ProjectRepository.updateScripts:decodeScripts",
      );
      const scriptsJson = yield* Effect.try({
        try: () => JSON.stringify(nextScripts),
        catch: toPersistenceSerializationError("ProjectRepository.updateScripts:encodeScripts"),
      });
      const nextUpdatedAt = new Date().toISOString();
      const updatedRow = yield* updateProjectScripts({
        id: input.id,
        scriptsJson,
        updatedAt: nextUpdatedAt,
      }).pipe(Effect.mapError(toPersistenceSqlError("ProjectRepository.updateScripts:update")));

      const updated = yield* rowToProjectRecord(
        updatedRow,
        "ProjectRepository.updateScripts:updated",
      );
      const result: ProjectUpdateScriptsResult = {
        project: {
          ...updated,
          scripts: cloneScripts(updated.scripts),
        },
      };
      return result;
    });

  const pruneMissing: ProjectRepositoryShape["pruneMissing"] = () =>
    listProjectRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectRepository.pruneMissing:query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => {
          const normalizedCwd = normalizeCwd(row.cwd);
          if (isDirectory(normalizedCwd)) {
            return Effect.void;
          }
          return deleteProject({ id: row.id }).pipe(
            Effect.mapError(toPersistenceSqlError("ProjectRepository.pruneMissing:delete")),
          );
        }),
      ),
      Effect.asVoid,
    );

  return {
    list,
    add,
    remove,
    updateScripts,
    pruneMissing,
  } satisfies ProjectRepositoryShape;
});

export const ProjectRepositoryLive = Layer.effect(ProjectRepository, makeRepository);

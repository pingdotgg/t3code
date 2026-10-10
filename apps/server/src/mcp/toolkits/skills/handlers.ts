import {
  OrchestratorMcpFailure,
  type ProjectId,
  type SkillRef,
  type SkillRequestError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SkillCatalog from "../../../skills/SkillCatalog.ts";
import * as SkillManager from "../../../skills/SkillManager.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable, type Caller } from "../../threadAccess.ts";
import { SkillsToolkit } from "./tools.ts";

const skillFailure = (error: SkillRequestError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/**
 * The folder of the project the call is about: the one passed, else the calling thread's.
 * Without either, project skills can't be reached: `required` says whether that is a failure
 * (a change to a project skill) or just means the global skills alone (a read).
 */
const projectFolder = Effect.fnUntraced(function* (
  context: Caller,
  projectId: ProjectId | undefined,
  required: boolean,
) {
  if (projectId === undefined && context.caller === undefined && !required) return undefined;
  const id = yield* resolveProjectId(context, projectId);
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(id).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project) || project.value.deletedAt !== null)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  return project.value.workspaceRoot;
});

/**
 * Changing skills rewrites the folders agents run from, so it needs full access;
 * `McpToolAccess.writesEnvironment` checks that. Only a change to a project skill needs a project.
 */
const changeFolder = (
  context: Caller,
  projectId: ProjectId | undefined,
  skills: ReadonlyArray<SkillRef>,
) =>
  projectFolder(
    context,
    projectId,
    skills.some((skill) => skill.scope === "project"),
  );

export const layer = McpToolAccess.toLayer(SkillsToolkit, {
  t3_skill_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const cwd = yield* projectFolder(context, input.projectId, false);
      const catalog = yield* SkillCatalog.SkillCatalog;
      return yield* catalog.list({ cwd }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_get: McpToolAccess.reads(({ projectId, ...skill }) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const cwd = yield* projectFolder(context, projectId, skill.scope === "project");
      const catalog = yield* SkillCatalog.SkillCatalog;
      return yield* catalog.get({ cwd, ...skill }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_enable: McpToolAccess.writesEnvironment(({ projectId, ...input }, check) =>
    Effect.gen(function* () {
      const cwd = yield* changeFolder(yield* check, projectId, input.skills);
      const manager = yield* SkillManager.SkillManager;
      return yield* manager.enable({ cwd, ...input }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_disable: McpToolAccess.writesEnvironment(({ projectId, ...input }, check) =>
    Effect.gen(function* () {
      const cwd = yield* changeFolder(yield* check, projectId, input.skills);
      const manager = yield* SkillManager.SkillManager;
      return yield* manager.disable({ cwd, ...input }).pipe(Effect.mapError(skillFailure));
    }),
  ),
});

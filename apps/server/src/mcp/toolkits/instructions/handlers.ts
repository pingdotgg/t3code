import { OrchestratorMcpFailure, type InstructionError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as InstructionCatalog from "../../../instructions/InstructionCatalog.ts";
import * as InstructionManager from "../../../instructions/InstructionManager.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable, type Caller } from "../../threadAccess.ts";
import { InstructionsToolkit } from "./tools.ts";

const GLOBAL_SHARED_ID = "global:shared";

const instructionFailure = (error: InstructionError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/**
 * The folder of the project the call is about: the one passed, else the calling thread's. Without
 * either, the call is about the user's home files alone.
 */
const projectFolder = Effect.fnUntraced(function* (
  context: Caller,
  projectId: ProjectId | undefined,
) {
  if (projectId === undefined && context.caller === undefined) return undefined;
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
 * Linking agents to the Global file rewrites files agents run from, so turning it on or off needs
 * full access; `McpToolAccess.writesEnvironment` checks that.
 */
export const layer = McpToolAccess.toLayer(InstructionsToolkit, {
  t3_instructions_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const cwd = yield* projectFolder(context, input.projectId);
      const catalog = yield* InstructionCatalog.InstructionCatalog;
      return yield* catalog.list({ cwd }).pipe(Effect.mapError(instructionFailure));
    }),
  ),
  t3_instructions_get: McpToolAccess.reads(({ projectId, id }) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const cwd = yield* projectFolder(context, projectId);
      const catalog = yield* InstructionCatalog.InstructionCatalog;
      return yield* catalog.read({ cwd, id }).pipe(Effect.mapError(instructionFailure));
    }),
  ),
  t3_instructions_enable: McpToolAccess.writesEnvironment(({ agents }) =>
    Effect.gen(function* () {
      const manager = yield* InstructionManager.InstructionManager;
      return yield* manager
        .enable({ id: GLOBAL_SHARED_ID, agents })
        .pipe(Effect.mapError(instructionFailure));
    }),
  ),
  t3_instructions_disable: McpToolAccess.writesEnvironment(({ agents }) =>
    Effect.gen(function* () {
      const manager = yield* InstructionManager.InstructionManager;
      return yield* manager
        .disable({ id: GLOBAL_SHARED_ID, agents })
        .pipe(Effect.mapError(instructionFailure));
    }),
  ),
});

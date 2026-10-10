import {
  mcpServerTransportSummary,
  OrchestratorMcpFailure,
  type ProjectId,
  type ServerSettings,
  type ServerSettingsPatch,
  type SkillInstallTarget,
} from "@t3tools/contracts";
import { mcpServerEnabledPatch, skillsDisabledPatch } from "@t3tools/shared/agentTools";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as SkillLibrary from "../../../skills/SkillLibrary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { ToolsToolkit } from "./tools.ts";

/** What agents and the Tools page see for one scope; secrets never leave the server. */
function toolsState(settings: ServerSettings, projectId: ProjectId | undefined) {
  const resolved = resolveProjectSettings(settings, projectId ?? null).settings;
  return {
    disabledSkills: [...resolved.disabledSkills],
    mcpServers: Object.entries(resolved.mcpServers).map(([name, server]) => ({
      name,
      enabled: server.enabled,
      summary: mcpServerTransportSummary(server.transport),
    })),
  };
}

const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { settings: yield* Settings.ServerSettingsService };
});

/** The project's checkout, as the target of an install. */
const projectTarget = (projectId: ProjectId | undefined) =>
  Effect.gen(function* () {
    if (projectId === undefined) return { kind: "environment" } satisfies SkillInstallTarget;
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects.getById(projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The project was not found.",
      });
    return { kind: "project", cwd: project.value.workspaceRoot } satisfies SkillInstallTarget;
  });

const libraryFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** Run a change while the calling thread holds its lock, re-checking it first. */
const asCaller = <A, E, R, CR>(
  check: Effect.Effect<unknown, OrchestratorMcpFailure, CR>,
  change: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const guarded = check.pipe(Effect.andThen(change));
    return yield* scope.thread === undefined
      ? guarded
      : executor.withLock(scope.thread.threadId, guarded);
  });

export const layer = McpToolAccess.toLayer(ToolsToolkit, {
  t3_tools_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return toolsState(current, input.projectId);
    }),
  ),
  t3_tools_update: McpToolAccess.writesEnvironment((input, check) =>
    asCaller(
      check,
      Effect.gen(function* () {
        const { settings } = yield* access;
        const projectId = input.projectId ?? null;
        // Each change builds on the last; the patch is then read off the result,
        // so everything lands in one write.
        let next = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
        for (const enabled of [true, false]) {
          const names = (input.skills ?? [])
            .filter((skill) => skill.enabled === enabled)
            .map((skill) => skill.name);
          if (names.length > 0) {
            next = applyServerSettingsPatch(
              next,
              skillsDisabledPatch(next, projectId, names, !enabled),
            );
          }
        }
        for (const server of input.mcpServers ?? []) {
          const step = mcpServerEnabledPatch(next, projectId, server.name, server.enabled);
          if (step === null)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `There is no Settings → Tools server named ${server.name}.`,
            });
          next = applyServerSettingsPatch(next, step);
        }
        const servers = (input.mcpServers ?? []).map((server) => server.name);
        const patch: ServerSettingsPatch =
          projectId === null
            ? {
                ...(input.skills === undefined ? {} : { disabledSkills: next.disabledSkills }),
                ...(servers.length === 0
                  ? {}
                  : {
                      mcpServers: Object.fromEntries(
                        servers.map((name) => [name, next.mcpServers[name] ?? null]),
                      ),
                    }),
              }
            : ({
                projectSettingsOverrides: {
                  [projectId]: next.projectSettingsOverrides[projectId] ?? null,
                },
              } as ServerSettingsPatch);
        const saved = yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable));
        return toolsState(saved, input.projectId);
      }),
    ),
  ),
  t3_skills_install: McpToolAccess.writesEnvironment((input, check) =>
    asCaller(
      check,
      Effect.gen(function* () {
        const library = yield* SkillLibrary.SkillLibrary;
        const target = yield* projectTarget(input.projectId);
        return yield* library
          .install({ source: input.source, skills: input.skills, target })
          .pipe(Effect.mapError(libraryFailure));
      }),
    ),
  ),
  t3_skills_remove: McpToolAccess.writesEnvironment((input, check) =>
    asCaller(
      check,
      Effect.gen(function* () {
        const library = yield* SkillLibrary.SkillLibrary;
        const target = yield* projectTarget(input.projectId);
        yield* library.remove({ name: input.name, target }).pipe(Effect.mapError(libraryFailure));
        return {};
      }),
    ),
  ),
});

import { AuthOrchestrationReadScope, EnvironmentHttpApi, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SkillCatalog from "./SkillCatalog.ts";

export const skillsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "skills",
  Effect.fnUntraced(function* (handlers) {
    const catalog = yield* SkillCatalog.SkillCatalog;
    const projects = yield* ProjectionSnapshotQuery;
    const resolveProjectDirectory = Effect.fn("skills.resolveProjectDirectory")(function* (
      projectId?: ProjectId,
    ) {
      if (projectId === undefined) return undefined;
      const project = yield* projects
        .getProjectShellById(projectId)
        .pipe(Effect.catch((cause) => failEnvironmentInternal("skills_discovery_failed", cause)));
      if (Option.isNone(project)) return yield* failEnvironmentNotFound("project_not_found");
      return project.value.workspaceRoot;
    });
    return handlers
      .handle(
        "list",
        Effect.fn("environment.skills.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const cwd = yield* resolveProjectDirectory(args.query.projectId);
          return yield* catalog
            .list(cwd)
            .pipe(
              Effect.catch((cause) => failEnvironmentInternal("skills_discovery_failed", cause)),
            );
        }),
      )
      .handle(
        "detail",
        Effect.fn("environment.skills.detail")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const cwd = yield* resolveProjectDirectory(args.query.projectId);
          const detail = yield* catalog.detail(args.params.scope, args.params.name, cwd).pipe(
            Effect.catchTags({
              SkillReadError: (cause) => failEnvironmentInternal("skill_read_failed", cause),
              SkillDiscoveryError: (cause) =>
                failEnvironmentInternal("skills_discovery_failed", cause),
            }),
          );
          if (Option.isNone(detail)) {
            return yield* failEnvironmentNotFound("skill_not_found");
          }
          return detail.value;
        }),
      );
  }),
);

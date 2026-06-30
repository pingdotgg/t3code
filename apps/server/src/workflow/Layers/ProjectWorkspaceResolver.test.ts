import { assert, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectWorkspaceResolver,
  ProjectWorkspaceResolverError,
} from "../Services/ProjectWorkspaceResolver.ts";
import { ProjectWorkspaceResolverLive } from "./ProjectWorkspaceResolver.ts";

const projectId = "project-1" as ProjectId;

const queryLayer = (getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"]) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getProjectShellById,
  } as unknown as ProjectionSnapshotQueryShape);

it.effect("ProjectWorkspaceResolver resolves a project workspaceRoot", () =>
  Effect.gen(function* () {
    const layer = ProjectWorkspaceResolverLive.pipe(
      Layer.provide(
        queryLayer(() =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Project",
              workspaceRoot: "/tmp/t3-project",
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-06-07T00:00:00.000Z" as never,
              updatedAt: "2026-06-07T00:00:00.000Z" as never,
            }),
          ),
        ),
      ),
    );

    const workspaceRoot = yield* Effect.gen(function* () {
      const resolver = yield* ProjectWorkspaceResolver;
      return yield* resolver.resolve(projectId);
    }).pipe(Effect.provide(layer));

    assert.equal(workspaceRoot, "/tmp/t3-project");
  }),
);

it.effect("ProjectWorkspaceResolver fails with a typed error for an unknown project", () =>
  Effect.gen(function* () {
    const layer = ProjectWorkspaceResolverLive.pipe(
      Layer.provide(queryLayer(() => Effect.succeed(Option.none()))),
    );

    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const resolver = yield* ProjectWorkspaceResolver;
        return yield* resolver.resolve("missing-project" as ProjectId);
      }).pipe(Effect.provide(layer)),
    );

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(String(result.cause).includes(ProjectWorkspaceResolverError.name));
    }
  }),
);

import { describe, expect, it } from "@effect/vitest";
import { CommandId, type Project, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ProjectNotEmptyError } from "./ProjectService.ts";
import { mutateProjectWithClone } from "./ProjectMutation.ts";

const projectId = ProjectId.make("project-1");
const deletedProject: Project = {
  id: projectId,
  title: "kh-frontend",
  workspaceRoot: "/workspace/kh-frontend",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: "2026-01-01T00:00:00.000Z",
};

describe("mutateProjectWithClone", () => {
  it.effect("keeps the clone when deletion is rejected", () =>
    Effect.gen(function* () {
      const rejected = new ProjectNotEmptyError({ projectId });
      const result = yield* mutateProjectWithClone(
        {
          create: () => Effect.die("unused"),
          update: () => Effect.die("unused"),
          delete: () => Effect.fail(rejected),
        },
        { discard: () => Effect.die("must not discard a project that still exists") },
        { type: "project.delete", commandId: CommandId.make("rejected-delete"), projectId },
      ).pipe(Effect.flip);

      expect(result).toBe(rejected);
    }),
  );

  it.effect("discards the clone record even when the caller disconnects mid-delete", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<void>();
      const finishDelete = yield* Deferred.make<void>();
      const discarded: Array<ProjectId> = [];
      const projects = {
        create: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        // The delete event is already durable while its post-commit cleanup runs.
        delete: () =>
          Deferred.succeed(committed, undefined).pipe(
            Effect.andThen(Deferred.await(finishDelete)),
            Effect.as(deletedProject),
          ),
      };
      const clones = {
        discard: (id: ProjectId) => Effect.sync(() => void discarded.push(id)),
      };

      const request = yield* mutateProjectWithClone(projects, clones, {
        type: "project.delete",
        commandId: CommandId.make("command-1"),
        projectId,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      // Delivered synchronously so it lands before the delete can finish.
      request.interruptUnsafe();
      yield* Deferred.succeed(finishDelete, undefined);
      yield* Fiber.await(request);

      expect(discarded).toEqual([projectId]);
    }),
  );
});

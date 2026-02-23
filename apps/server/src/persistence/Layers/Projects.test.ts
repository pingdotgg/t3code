import { Effect, Layer, FileSystem } from "effect";
import { assert, it } from "@effect/vitest";

import { ProjectRepository } from "../Services/Projects.ts";
import { ProjectRepositoryLive } from "./Projects.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { NodeServices } from "@effect/platform-node";

const layer = it.layer(
  Layer.mergeAll(Layer.provide(ProjectRepositoryLive, SqlitePersistenceMemory), NodeServices.layer),
);

layer("ProjectRepository", (it) => {
  it.effect("stores projects and deduplicates adds by cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectDir = yield* fs.makeTempDirectoryScoped();

      const repository = yield* ProjectRepository;

      const created = yield* repository.add({ cwd: projectDir });
      assert.equal(created.created, true);

      const duplicate = yield* repository.add({ cwd: projectDir });
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.project.id, created.project.id);

      const listed = yield* repository.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.cwd, projectDir);
    }),
  );

  it.effect("prunes missing project paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const existing = yield* fs.makeTempDirectoryScoped();
      const missing = yield* fs.makeTempDirectory();

      const repository = yield* ProjectRepository;

      const existingProject = yield* repository.add({ cwd: existing });
      const missingProject = yield* repository.add({ cwd: missing });

      assert.isTrue(existingProject.created);
      assert.isTrue(missingProject.created);

      yield* fs.remove(missing, { recursive: true, force: true });

      yield* repository.pruneMissing();
      const listed = yield* repository.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.cwd, existing);
    }),
  );
});

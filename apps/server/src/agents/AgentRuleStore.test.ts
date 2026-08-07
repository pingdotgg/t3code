import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { AgentProfileId, AgentRuleDocument } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentProjectFileCoordinator from "./AgentProjectFileCoordinator.ts";
import * as AgentRuleStore from "./AgentRuleStore.ts";

const decodeRule = Schema.decodeUnknownEffect(AgentRuleDocument);
const rule = (scope: "environment" | "project", id = "typescript") =>
  decodeRule({
    id,
    scope,
    revision: "0".repeat(64),
    name: "TypeScript",
    globs: ["**/*.ts"],
    alwaysApply: false,
    priority: 0,
    sourcePath: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    body: "Use strict types.",
    profiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
const withStore = <A, E, R>(
  workspaceRoot: string,
  baseDir: string,
  effect: Effect.Effect<A, E, AgentRuleStore.AgentRuleStore | R>,
) =>
  effect.pipe(
    Effect.provide(
      AgentRuleStore.layer.pipe(
        Layer.provide(AgentCatalog.layer),
        Layer.provide(AgentProjectFileCoordinator.layer),
        Layer.provide(T3ProjectFileLoader.layer),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
      ),
    ),
  );

it.layer(NodeServices.layer)("AgentRuleStore", (it) => {
  it.effect("writes, compare-and-swaps, archives, and restores an environment rule", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rule-store-" });
      const initial = yield* rule("environment");
      const saved = yield* withStore(
        tempDir,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) => store.save({ rule: initial })),
        ),
      );
      const updated = yield* withStore(
        tempDir,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) =>
            store.save({
              rule: { ...saved, body: "Use strict types and tests." },
              expectedRevision: saved.revision,
            }),
          ),
        ),
      );
      assert.notEqual(updated.revision, saved.revision);
      assert.equal(updated.body, "Use strict types and tests.");
      const archived = yield* withStore(
        tempDir,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) =>
            store.archive({
              ref: { id: AgentProfileId.make(updated.id), scope: updated.scope },
              expectedRevision: updated.revision,
            }),
          ),
        ),
      );
      assert.isNotNull(archived.archivedAt);
      const restored = yield* withStore(
        tempDir,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) =>
            store.restore({
              ref: { id: AgentProfileId.make(archived.id), scope: archived.scope },
              expectedRevision: archived.revision,
            }),
          ),
        ),
      );
      assert.equal(restored.archivedAt, null);
      assert.match(
        yield* fileSystem.readFileString(path.join(tempDir, "userdata", "rules", "typescript.md")),
        /Use strict types and tests\./,
      );
    }),
  );

  it.effect("writes one checked-in project rule reference", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rule-store-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      const initial = yield* rule("project", "project-typescript");
      const saved = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) => store.save({ rule: initial, workspaceRoot: workspace })),
        ),
      );
      yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) =>
            store.save({
              rule: { ...saved, body: "Project TypeScript." },
              expectedRevision: saved.revision,
              workspaceRoot: workspace,
            }),
          ),
        ),
      );
      const projectFile = yield* fileSystem.readFileString(path.join(workspace, "t3.json"));
      assert.equal((projectFile.match(/project-typescript/g) ?? []).length, 2);
      assert.match(
        yield* fileSystem.readFileString(
          path.join(workspace, ".t3code", "rules", "project-typescript.md"),
        ),
        /Project TypeScript\./,
      );
    }),
  );

  it.effect("rolls back a new project rule when its t3.json reference cannot be written", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rule-store-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      yield* fileSystem.writeFileString(path.join(workspace, "t3.json"), "not JSON");
      const initial = yield* rule("project", "rollback-typescript");
      const result = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) => store.save({ rule: initial, workspaceRoot: workspace })),
          Effect.result,
        ),
      );
      assert.isTrue(Result.isFailure(result));
      assert.isFalse(
        yield* fileSystem.exists(
          path.join(workspace, ".t3code", "rules", "rollback-typescript.md"),
        ),
      );
    }),
  );

  it.effect("restores an existing project rule when its t3.json reference cannot be written", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rule-store-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      const initial = yield* rule("project", "restore-typescript");
      const saved = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) => store.save({ rule: initial, workspaceRoot: workspace })),
        ),
      );
      yield* fileSystem.writeFileString(path.join(workspace, "t3.json"), "not JSON");

      const result = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentRuleStore.AgentRuleStore).pipe(
          Effect.flatMap((store) =>
            store.save({
              rule: { ...saved, body: "This write must be rolled back." },
              workspaceRoot: workspace,
            }),
          ),
          Effect.result,
        ),
      );

      assert.isTrue(Result.isFailure(result));
      assert.match(
        yield* fileSystem.readFileString(
          path.join(workspace, ".t3code", "rules", "restore-typescript.md"),
        ),
        /Use strict types\./,
      );
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { AgentProfileDocument } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentProfileStore from "./AgentProfileStore.ts";

const decodeProfile = Schema.decodeUnknownEffect(AgentProfileDocument);
const INITIAL_REVISION = "0".repeat(64);
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const profile = (input: {
  readonly id: string;
  readonly scope: "environment" | "project";
  readonly instructions: string;
  readonly sourcePath: string | null;
}) =>
  decodeProfile({
    id: input.id,
    scope: input.scope,
    revision: INITIAL_REVISION,
    name: input.id,
    defaultModelSelection: null,
    sourcePath: input.sourcePath,
    requirements: { toolRequirement: "none", t3McpCapabilities: [] },
    archivedAt: null,
    updatedAt: CREATED_AT,
    instructions: input.instructions,
    instructionPriority: "prompt",
    runtime: { mode: "auto", interactionMode: "default" },
    workspace: { mode: "shared", access: "read-only" },
    tools: { policy: "inherit", allowed: [] },
    delegation: { policy: "disabled", profiles: [] },
    budgets: { maxRuns: 1, maxConcurrency: 1, maxDepth: 0, maxWallTimeMinutes: 1 },
    hooks: [],
    rules: [],
    createdAt: CREATED_AT,
  });

const withStore = <A, E, R>(
  workspaceRoot: string,
  baseDir: string,
  effect: Effect.Effect<A, E, AgentProfileStore.AgentProfileStore | R>,
) =>
  effect.pipe(
    Effect.provide(
      AgentProfileStore.layer.pipe(
        Layer.provide(AgentCatalog.layer),
        Layer.provide(T3ProjectFileLoader.layer),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
      ),
    ),
  );

it.layer(NodeServices.layer)("AgentProfileStore", (it) => {
  it.effect("creates, compare-and-swaps, archives, and restores an environment profile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-store-" });
      const workspace = path.join(tempDir, "workspace");
      const initial = yield* profile({
        id: "reviewer",
        scope: "environment",
        instructions: "Review the diff.",
        sourcePath: "elsewhere.md",
      });

      const saved = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentProfileStore.AgentProfileStore).pipe(
          Effect.flatMap((store) => store.save({ profile: initial })),
        ),
      );
      assert.notEqual(saved.revision, INITIAL_REVISION);
      assert.equal(saved.instructions, "Review the diff.");
      assert.equal(saved.chatSelectable, true);
      assert.isTrue(
        yield* fileSystem.exists(path.join(tempDir, "userdata", "agents", "reviewer.md")),
      );
      assert.isFalse(yield* fileSystem.exists(path.join(tempDir, "userdata", "elsewhere.md")));

      const changed = { ...saved, instructions: "Review the diff and tests." };
      const updated = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentProfileStore.AgentProfileStore).pipe(
          Effect.flatMap((store) =>
            store.save({ profile: changed, expectedRevision: saved.revision }),
          ),
        ),
      );
      assert.notEqual(updated.revision, saved.revision);
      assert.equal(updated.instructions, "Review the diff and tests.");

      const archived = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentProfileStore.AgentProfileStore).pipe(
          Effect.flatMap((store) =>
            store.archive({
              ref: { id: updated.id, scope: updated.scope },
              expectedRevision: updated.revision,
            }),
          ),
        ),
      );
      assert.isNotNull(archived.archivedAt);

      const restored = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentProfileStore.AgentProfileStore).pipe(
          Effect.flatMap((store) =>
            store.restore({
              ref: { id: archived.id, scope: archived.scope },
              expectedRevision: archived.revision,
            }),
          ),
        ),
      );
      assert.equal(restored.archivedAt, null);
    }),
  );

  it.effect("writes a project profile and keeps its explicit t3.json reference singular", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-store-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      const initial = yield* profile({
        id: "project-reviewer",
        scope: "project",
        instructions: "Review this repository.",
        sourcePath: ".t3code/agents/project-reviewer.md",
      });

      const saved = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentProfileStore.AgentProfileStore).pipe(
          Effect.flatMap((store) => store.save({ profile: initial, workspaceRoot: workspace })),
        ),
      );
      const updated = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentProfileStore.AgentProfileStore).pipe(
          Effect.flatMap((store) =>
            store.save({
              profile: { ...saved, instructions: "Review this repository carefully." },
              expectedRevision: saved.revision,
              workspaceRoot: workspace,
            }),
          ),
        ),
      );
      assert.notEqual(updated.revision, saved.revision);

      const projectFile = yield* fileSystem.readFileString(path.join(workspace, "t3.json"));
      assert.equal((projectFile.match(/project-reviewer/g) ?? []).length, 2);
      const document = yield* fileSystem.readFileString(
        path.join(workspace, ".t3code", "agents", "project-reviewer.md"),
      );
      assert.match(document, /Review this repository carefully\./);
    }),
  );

  it.effect("rolls back a new project profile when its t3.json reference cannot be written", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-store-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      yield* fileSystem.writeFileString(path.join(workspace, "t3.json"), "not JSON");
      const initial = yield* profile({
        id: "rollback-reviewer",
        scope: "project",
        instructions: "This must not be left behind.",
        sourcePath: null,
      });
      const result = yield* withStore(
        workspace,
        tempDir,
        Effect.service(AgentProfileStore.AgentProfileStore).pipe(
          Effect.flatMap((store) => store.save({ profile: initial, workspaceRoot: workspace })),
          Effect.result,
        ),
      );
      assert.isTrue(Result.isFailure(result));
      assert.isFalse(
        yield* fileSystem.exists(path.join(workspace, ".t3code", "agents", "rollback-reviewer.md")),
      );
    }),
  );
});

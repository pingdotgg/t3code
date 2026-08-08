import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { AgentProfileDocument, AgentRuleDocument } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentProjectFileCoordinator from "./AgentProjectFileCoordinator.ts";
import * as AgentProfileStore from "./AgentProfileStore.ts";
import * as AgentProfileServices from "./AgentProfileServices.ts";
import * as AgentRuleStore from "./AgentRuleStore.ts";

const decodeProfile = Schema.decodeUnknownEffect(AgentProfileDocument);
const decodeRule = Schema.decodeUnknownEffect(AgentRuleDocument);
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

const rule = (id: string) =>
  decodeRule({
    id,
    scope: "project",
    revision: INITIAL_REVISION,
    name: id,
    globs: ["**/*.ts"],
    alwaysApply: false,
    priority: 0,
    sourcePath: `.t3code/rules/${id}.md`,
    updatedAt: CREATED_AT,
    archivedAt: null,
    body: "Use strict types.",
    profiles: [],
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
        Layer.provide(AgentProjectFileCoordinator.layer),
        Layer.provide(T3ProjectFileLoader.layer),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
      ),
    ),
  );

const withStores = <A, E, R>(
  workspaceRoot: string,
  baseDir: string,
  effect: Effect.Effect<
    A,
    E,
    AgentProfileStore.AgentProfileStore | AgentRuleStore.AgentRuleStore | R
  >,
) =>
  effect.pipe(
    Effect.provide(
      AgentProfileServices.layer.pipe(
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

  it.effect("serializes concurrent profile and rule t3.json reference writes per workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-store-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      const projectProfile = yield* profile({
        id: "concurrent-reviewer",
        scope: "project",
        instructions: "Review concurrent writes.",
        sourcePath: ".t3code/agents/concurrent-reviewer.md",
      });
      const projectRule = yield* rule("concurrent-typescript");

      yield* withStores(
        workspace,
        tempDir,
        Effect.gen(function* () {
          const profileStore = yield* AgentProfileStore.AgentProfileStore;
          const ruleStore = yield* AgentRuleStore.AgentRuleStore;
          yield* Effect.all(
            [
              profileStore.save({ profile: projectProfile, workspaceRoot: workspace }),
              ruleStore.save({ rule: projectRule, workspaceRoot: workspace }),
            ],
            { concurrency: "unbounded" },
          );
        }),
      );

      const projectFile = yield* fileSystem.readFileString(path.join(workspace, "t3.json"));
      assert.match(projectFile, /concurrent-reviewer/);
      assert.match(projectFile, /concurrent-typescript/);
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

  it.effect(
    "restores an existing project profile when its t3.json reference cannot be written",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-store-" });
        const workspace = path.join(tempDir, "workspace");
        yield* fileSystem.makeDirectory(workspace, { recursive: true });
        const initial = yield* profile({
          id: "restore-reviewer",
          scope: "project",
          instructions: "Keep the original document.",
          sourcePath: ".t3code/agents/restore-reviewer.md",
        });
        const saved = yield* withStore(
          workspace,
          tempDir,
          Effect.service(AgentProfileStore.AgentProfileStore).pipe(
            Effect.flatMap((store) => store.save({ profile: initial, workspaceRoot: workspace })),
          ),
        );
        yield* fileSystem.writeFileString(path.join(workspace, "t3.json"), "not JSON");

        const result = yield* withStore(
          workspace,
          tempDir,
          Effect.service(AgentProfileStore.AgentProfileStore).pipe(
            Effect.flatMap((store) =>
              store.save({
                profile: { ...saved, instructions: "This write must be rolled back." },
                workspaceRoot: workspace,
              }),
            ),
            Effect.result,
          ),
        );

        assert.isTrue(Result.isFailure(result));
        assert.match(
          yield* fileSystem.readFileString(
            path.join(workspace, ".t3code", "agents", "restore-reviewer.md"),
          ),
          /Keep the original document\./,
        );
      }),
  );
});

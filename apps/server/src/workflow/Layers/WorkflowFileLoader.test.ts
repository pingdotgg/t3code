// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  WorkflowDefinition,
  WorkflowRpcError,
  type BoardId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import {
  WorkflowFileLoader,
  WorkflowFilePort,
  WorkflowProviderInstancePort,
} from "../Services/WorkflowFileLoader.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowFileLoaderLive } from "./WorkflowFileLoader.ts";
import { WorkflowReadModelLive } from "./WorkflowReadModel.ts";

const workflowJson = (providerInstance = "codex_main") =>
  JSON.stringify({
    name: "Delivery Board",
    settings: { maxConcurrentTickets: 2 },
    lanes: [
      {
        key: "code",
        name: "Code",
        entry: "auto",
        pipeline: [
          {
            key: "implement",
            type: "agent",
            agent: { instance: providerInstance, model: "gpt-5.5" },
            instruction: { file: "prompts/implement.md" },
          },
        ],
        on: { success: "done" },
      },
      { key: "done", name: "Done", entry: "manual", terminal: true },
    ],
  });

const scriptTimeoutWorkflowJson = () =>
  JSON.stringify({
    name: "Script Timeout Board",
    lanes: [
      {
        key: "run",
        name: "Run",
        entry: "auto",
        pipeline: [{ key: "smoke", type: "script", run: "echo hi", timeout: "1 minute" }],
        on: { success: "done" },
      },
      { key: "done", name: "Done", entry: "manual", terminal: true },
    ],
  });

const invalidWipWorkflowJson = () =>
  JSON.stringify({
    name: "Invalid WIP Board",
    lanes: [
      { key: "queue", name: "Queue", entry: "manual", wipLimit: 0 },
      { key: "done", name: "Done", entry: "manual", terminal: true, wipLimit: 1 },
    ],
  });

const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));
const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);

const mk = (providerInstanceExists: (instanceId: string) => boolean) =>
  it.layer(
    WorkflowFileLoaderLive.pipe(
      Layer.provideMerge(
        Layer.succeed(WorkflowFilePort, {
          readFileString: () => Effect.succeed(workflowJson()),
          instructionFileExists: ({ repoRelativePath }) =>
            Effect.succeed(repoRelativePath === "prompts/implement.md"),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowProviderInstancePort, {
          providerInstanceExists: (instanceId) =>
            Effect.succeed(providerInstanceExists(instanceId)),
          providerInstanceSupportsResume: (instanceId) =>
            Effect.succeed(providerInstanceExists(instanceId)),
        }),
      ),
      Layer.provideMerge(WorkflowReadModelLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  );

mk((instanceId) => instanceId === "codex_main")("WorkflowFileLoader", (it) => {
  it.effect("loads, lints, registers, and persists a workflow board", () =>
    Effect.gen(function* () {
      const loader = yield* WorkflowFileLoader;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const boardId = "board-loader" as BoardId;

      const loadedBoardId = yield* loader.loadAndRegister({
        boardId,
        projectId: "project-loader" as ProjectId,
        workspaceRoot: "/repo",
        relativePath: ".t3/boards/delivery.json",
      });

      const definition = yield* registry.getDefinition(boardId);
      const board = yield* read.getBoard(boardId);

      assert.equal(loadedBoardId, boardId);
      assert.equal(definition?.name, "Delivery Board");
      assert.equal(board?.name, "Delivery Board");
      assert.equal(board?.workflowFilePath, ".t3/boards/delivery.json");
      assert.equal(board?.maxConcurrentTickets, 2);
      assert.isTrue((board?.workflowVersionHash.length ?? 0) > 0);
    }),
  );
});

it.effect("WorkflowFileLoader lintDefinition reuses provider and instruction-file context", () => {
  const providerChecks: string[] = [];
  const instructionChecks: Array<{ readonly repoRoot: string; readonly repoRelativePath: string }> =
    [];
  const layer = WorkflowFileLoaderLive.pipe(
    Layer.provideMerge(
      Layer.succeed(WorkflowFilePort, {
        readFileString: (filePath) =>
          String(filePath).endsWith("prompts/implement.md")
            ? Effect.succeed("Implement {{ticket.title}}.")
            : Effect.die("lintDefinition must not read a workflow file"),
        instructionFileExists: (input) => {
          instructionChecks.push(input);
          return Effect.succeed(
            input.repoRoot === "/repo" && input.repoRelativePath === "prompts/implement.md",
          );
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowProviderInstancePort, {
        providerInstanceExists: (instanceId) => {
          providerChecks.push(instanceId);
          return Effect.succeed(instanceId === "codex_main");
        },
        providerInstanceSupportsResume: (instanceId) => Effect.succeed(instanceId === "codex_main"),
      }),
    ),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return Effect.gen(function* () {
    const loader = yield* WorkflowFileLoader;
    const definition = yield* decodeWorkflowDefinitionJson(workflowJson());
    const errors = yield* loader.lintDefinition({
      definition,
      projectId: "project-loader" as ProjectId,
      workspaceRoot: "/repo",
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(providerChecks, ["codex_main"]);
    assert.deepEqual(instructionChecks, [
      { repoRoot: "/repo", repoRelativePath: "prompts/implement.md" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("WorkflowFileLoader lintDefinition returns lint errors without registering", () => {
  const layer = WorkflowFileLoaderLive.pipe(
    Layer.provideMerge(
      Layer.succeed(WorkflowFilePort, {
        readFileString: () => Effect.die("lintDefinition must not read a workflow file"),
        instructionFileExists: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowProviderInstancePort, {
        providerInstanceExists: () => Effect.succeed(false),
        providerInstanceSupportsResume: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return Effect.gen(function* () {
    const loader = yield* WorkflowFileLoader;
    const registry = yield* BoardRegistry;
    const boardId = "board-lint-only" as BoardId;
    const definition = yield* decodeWorkflowDefinitionJson(workflowJson());
    const errors = yield* loader.lintDefinition({
      definition,
      projectId: "project-loader" as ProjectId,
      workspaceRoot: "/repo",
    });

    assert.deepEqual(
      errors.map((error) => ({
        code: error.code,
        laneKey: error.laneKey,
        stepKey: error.stepKey,
      })),
      [
        { code: "unknown_provider_instance", laneKey: "code", stepKey: "implement" },
        { code: "missing_instruction_file", laneKey: "code", stepKey: "implement" },
      ],
    );
    assert.isNull(yield* registry.getDefinition(boardId));
  }).pipe(Effect.provide(layer));
});

it.effect(
  "WorkflowFileLoader lintDefinition rejects unsafe instruction paths before file checks",
  () => {
    const instructionChecks: Array<{
      readonly repoRoot: string;
      readonly repoRelativePath: string;
    }> = [];
    const layer = WorkflowFileLoaderLive.pipe(
      Layer.provideMerge(
        Layer.succeed(WorkflowFilePort, {
          readFileString: () => Effect.die("lintDefinition must not read a workflow file"),
          instructionFileExists: (input) => {
            instructionChecks.push(input);
            return Effect.succeed(true);
          },
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowProviderInstancePort, {
          providerInstanceExists: (instanceId) => Effect.succeed(instanceId === "codex_main"),
          providerInstanceSupportsResume: (instanceId) =>
            Effect.succeed(instanceId === "codex_main"),
        }),
      ),
      Layer.provideMerge(WorkflowReadModelLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const loader = yield* WorkflowFileLoader;
      const definition = yield* decodeWorkflowDefinition({
        name: "Unsafe Instruction Board",
        lanes: [
          {
            key: "code",
            name: "Code",
            entry: "auto",
            pipeline: [
              {
                key: "implement",
                type: "agent",
                agent: { instance: "codex_main", model: "gpt-5.5" },
                instruction: { file: "../escape.md" },
              },
            ],
          },
        ],
      });
      const errors = yield* loader.lintDefinition({
        definition,
        projectId: "project-loader" as ProjectId,
        workspaceRoot: "/repo",
      });

      assert.deepEqual(
        errors.map((error) => ({
          code: error.code,
          laneKey: error.laneKey,
          stepKey: error.stepKey,
        })),
        [{ code: "unsafe_instruction_path", laneKey: "code", stepKey: "implement" }],
      );
      assert.deepEqual(instructionChecks, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "WorkflowFileLoader lintDefinition gates continueSession on provider resume support",
  () => {
    const continueSessionJson = (providerInstance: string) =>
      JSON.stringify({
        name: "Resume Board",
        lanes: [
          {
            key: "code",
            name: "Code",
            entry: "auto",
            pipeline: [
              {
                key: "implement",
                type: "agent",
                agent: { instance: providerInstance, model: "gpt-5.5" },
                instruction: "Implement {{ticket.title}}.",
                continueSession: true,
              },
            ],
            on: { success: "done" },
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
    const layer = WorkflowFileLoaderLive.pipe(
      Layer.provideMerge(
        Layer.succeed(WorkflowFilePort, {
          readFileString: () => Effect.die("lintDefinition must not read a workflow file"),
          instructionFileExists: () => Effect.succeed(true),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowProviderInstancePort, {
          // Both instances exist; only opencode lacks resume support.
          providerInstanceExists: () => Effect.succeed(true),
          providerInstanceSupportsResume: (instanceId) =>
            Effect.succeed(instanceId !== "opencode_main"),
        }),
      ),
      Layer.provideMerge(WorkflowReadModelLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const loader = yield* WorkflowFileLoader;

      const resumableDef = yield* decodeWorkflowDefinitionJson(continueSessionJson("codex_main"));
      const resumableErrors = yield* loader.lintDefinition({
        definition: resumableDef,
        projectId: "project-loader" as ProjectId,
        workspaceRoot: "/repo",
      });
      assert.deepEqual(resumableErrors, []);

      const nonResumableDef = yield* decodeWorkflowDefinitionJson(
        continueSessionJson("opencode_main"),
      );
      const nonResumableErrors = yield* loader.lintDefinition({
        definition: nonResumableDef,
        projectId: "project-loader" as ProjectId,
        workspaceRoot: "/repo",
      });
      assert.deepEqual(
        nonResumableErrors.map((error) => ({ code: error.code, stepKey: error.stepKey })),
        [{ code: "invalid_continue_session", stepKey: "implement" }],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("WorkflowFileLoader registers a workflow board whose script step has a timeout", () => {
  const layer = WorkflowFileLoaderLive.pipe(
    Layer.provideMerge(
      Layer.succeed(WorkflowFilePort, {
        readFileString: () => Effect.succeed(scriptTimeoutWorkflowJson()),
        instructionFileExists: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowProviderInstancePort, {
        providerInstanceExists: () => Effect.succeed(false),
        providerInstanceSupportsResume: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return Effect.gen(function* () {
    const loader = yield* WorkflowFileLoader;
    const registry = yield* BoardRegistry;
    const read = yield* WorkflowReadModel;
    const boardId = "board-script-timeout" as BoardId;

    const loadedBoardId = yield* loader.loadAndRegister({
      boardId,
      projectId: "project-loader" as ProjectId,
      workspaceRoot: "/repo",
      relativePath: ".t3/boards/script-timeout.json",
    });

    const definition = yield* registry.getDefinition(boardId);
    const board = yield* read.getBoard(boardId);
    const step = definition?.lanes[0]?.pipeline?.[0];

    assert.equal(loadedBoardId, boardId);
    assert.equal(definition?.name, "Script Timeout Board");
    assert.equal(step?.type, "script");
    if (step?.type === "script") {
      const timeout = step.timeout;
      assert.isDefined(timeout);
      if (timeout !== undefined) {
        assert.equal(Duration.toMillis(timeout), 60_000);
      }
    }
    assert.equal(board?.name, "Script Timeout Board");
    assert.equal(board?.workflowFilePath, ".t3/boards/script-timeout.json");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "WorkflowFileLoader reads from the workspace-root path and persists the relative path",
  () => {
    let workspaceRoot = "";
    return Effect.gen(function* () {
      workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workflow-loader-"));
      const relativePath = ".t3/boards/split.json";
      const absolutePath = NodePath.resolve(workspaceRoot, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
      NodeFS.writeFileSync(absolutePath, workflowJson(), "utf8");

      const readPath = yield* Ref.make<string | null>(null);
      const layer = WorkflowFileLoaderLive.pipe(
        Layer.provideMerge(
          Layer.succeed(WorkflowFilePort, {
            readFileString: (filePath) =>
              Effect.gen(function* () {
                if (String(filePath).endsWith(".json")) {
                  yield* Ref.set(readPath, filePath);
                }
                return yield* Effect.try({
                  try: () => NodeFS.readFileSync(filePath, "utf8"),
                  catch: (cause) =>
                    new WorkflowRpcError({ message: "test workflow file read failed", cause }),
                });
              }),
            instructionFileExists: ({ repoRelativePath }) =>
              Effect.succeed(repoRelativePath === "prompts/implement.md"),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkflowProviderInstancePort, {
            providerInstanceExists: (instanceId) => Effect.succeed(instanceId === "codex_main"),
            providerInstanceSupportsResume: (instanceId) =>
              Effect.succeed(instanceId === "codex_main"),
          }),
        ),
        Layer.provideMerge(WorkflowReadModelLive),
        Layer.provideMerge(BoardRegistryLive),
        Layer.provideMerge(MigrationsLive),
        Layer.provideMerge(SqlitePersistenceMemory),
      );

      yield* Effect.gen(function* () {
        const loader = yield* WorkflowFileLoader;
        const read = yield* WorkflowReadModel;
        const boardId = "board-split-path" as BoardId;

        yield* loader.loadAndRegister({
          boardId,
          projectId: "project-loader" as ProjectId,
          workspaceRoot,
          relativePath,
        });

        assert.equal(yield* Ref.get(readPath), absolutePath);
        const board = yield* read.getBoard(boardId);
        assert.equal(board?.workflowFilePath, relativePath);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (workspaceRoot !== "") {
            NodeFS.rmSync(workspaceRoot, { recursive: true, force: true });
          }
        }),
      ),
    );
  },
);

it.effect("WorkflowFileLoader blocks activation for invalid WIP limits", () => {
  const layer = WorkflowFileLoaderLive.pipe(
    Layer.provideMerge(
      Layer.succeed(WorkflowFilePort, {
        readFileString: () => Effect.succeed(invalidWipWorkflowJson()),
        instructionFileExists: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowProviderInstancePort, {
        providerInstanceExists: () => Effect.succeed(false),
        providerInstanceSupportsResume: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return Effect.gen(function* () {
    const loader = yield* WorkflowFileLoader;
    const result = yield* Effect.exit(
      loader.loadAndRegister({
        boardId: "board-invalid-wip" as BoardId,
        projectId: "project-loader" as ProjectId,
        workspaceRoot: "/repo",
        relativePath: ".t3/boards/invalid-wip.json",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(result.cause.toString().includes("invalid_wip_limit"));
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "WorkflowFileLoader rejects an oversized on-disk definition without registering it",
  () => {
    // A hand-edited file with more lanes than MAX_IMPORT_LANES (1000): recovery/
    // discovery must reject it via the shared caps, never register it.
    const oversizedJson = JSON.stringify({
      name: "Oversized Board",
      lanes: [
        ...Array.from({ length: 1001 }, (_, index) => ({
          key: `lane-${index}`,
          name: `Lane ${index}`,
          entry: "manual",
        })),
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const layer = WorkflowFileLoaderLive.pipe(
      Layer.provideMerge(
        Layer.succeed(WorkflowFilePort, {
          readFileString: () => Effect.succeed(oversizedJson),
          instructionFileExists: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowProviderInstancePort, {
          providerInstanceExists: () => Effect.succeed(false),
          providerInstanceSupportsResume: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(WorkflowReadModelLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const loader = yield* WorkflowFileLoader;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const boardId = "board-oversized" as BoardId;

      const result = yield* Effect.exit(
        loader.loadAndRegister({
          boardId,
          projectId: "project-loader" as ProjectId,
          workspaceRoot: "/repo",
          relativePath: ".t3/boards/oversized.json",
        }),
      );

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(result.cause.toString().includes("too large"));
      }
      // Neither the registry nor the projection should have the board.
      assert.isNull(yield* registry.getDefinition(boardId));
      assert.isNull(yield* read.getBoard(boardId));
    }).pipe(Effect.provide(layer));
  },
);

mk(() => false)("WorkflowFileLoader lint failure", (it) => {
  it.effect("fails when the workflow references an unknown provider instance", () =>
    Effect.gen(function* () {
      const loader = yield* WorkflowFileLoader;

      const result = yield* Effect.exit(
        loader.loadAndRegister({
          boardId: "board-loader-fail" as BoardId,
          projectId: "project-loader" as ProjectId,
          workspaceRoot: "/repo",
          relativePath: ".t3/boards/delivery.json",
        }),
      );

      assert.strictEqual(result._tag, "Failure");
    }),
  );
});

import { NodeServices } from "@effect/platform-node";
import { AgentProfileDocument, type AgentHook } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentHookRunner from "./AgentHookRunner.ts";

const RunnerDependencies = Layer.merge(
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
);
const TestLayer = AgentHookRunner.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);
const decodeAgentProfileDocument = Schema.decodeUnknownSync(AgentProfileDocument);

const profileWithHook = (hook: AgentHook) =>
  decodeAgentProfileDocument({
    id: "hook-reviewer",
    scope: "environment",
    revision: "a".repeat(64),
    name: "Hook reviewer",
    defaultModelSelection: null,
    sourcePath: null,
    requirements: { toolRequirement: "none", t3McpCapabilities: [] },
    archivedAt: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
    instructions: "Review the change.",
    instructionPriority: "prompt",
    runtime: { mode: "auto", interactionMode: "default" },
    workspace: { mode: "shared", access: "read-only" },
    tools: { policy: "inherit", allowed: [] },
    delegation: { policy: "disabled", profiles: [] },
    budgets: { maxRuns: 1, maxConcurrency: 1, maxDepth: 0, maxWallTimeMinutes: 1 },
    hooks: [hook],
    rules: [],
    createdAt: "1970-01-01T00:00:00.000Z",
  });

it.effect("reads context hooks through a validated file handle", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-" });
    yield* fileSystem.writeFileString(path.join(workspaceRoot, "context.txt"), "trusted context");
    const runner = yield* AgentHookRunner.AgentHookRunner;
    const result = yield* runner.run({
      profile: profileWithHook({
        kind: "context",
        path: "context.txt",
        stage: "promptBuild",
        timeoutSeconds: 1,
        failurePolicy: "block",
      }),
      stage: "promptBuild",
      workspaceRoot,
    });
    assert.deepEqual(result.context, ["trusted context"]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("truncates context at a valid UTF-8 boundary", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hook-utf8-" });
    yield* fileSystem.writeFileString(path.join(workspaceRoot, "context.txt"), "😀".repeat(20_000));
    const runner = yield* AgentHookRunner.AgentHookRunner;
    const result = yield* runner.run({
      profile: profileWithHook({
        kind: "context",
        path: "context.txt",
        stage: "promptBuild",
        timeoutSeconds: 1,
        failurePolicy: "block",
      }),
      stage: "promptBuild",
      workspaceRoot,
    });
    const context = result.context[0] ?? "";
    const visible = context.replace("\n[hook context truncated]", "");
    assert.notInclude(visible, "�");
    assert.isAtMost(Buffer.byteLength(visible, "utf8"), 64 * 1024);
    assert.match(context, /\[hook context truncated\]$/);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("enforces timeoutSeconds while a context filesystem operation is stalled", () =>
  Effect.gen(function* () {
    const stalledFileSystem = FileSystem.makeNoop({
      realPath: () => Effect.never,
    });
    const runner = yield* AgentHookRunner.make.pipe(
      Effect.provideService(FileSystem.FileSystem, stalledFileSystem),
      Effect.provide(RunnerDependencies),
    );
    const profile = profileWithHook({
      kind: "context",
      path: "context.txt",
      stage: "promptBuild",
      timeoutSeconds: 1,
      failurePolicy: "block",
    });
    const error = yield* runner
      .run({
        profile: {
          ...profile,
          hooks: [{ ...profile.hooks[0]!, timeoutSeconds: 0 }],
        },
        stage: "promptBuild",
        workspaceRoot: "workspace",
      })
      .pipe(Effect.flip);
    assert.equal(error.detail, "Context hook timed out after 0 seconds.");
  }),
);
